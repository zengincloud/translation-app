require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const FormData = require('form-data');
const fetch = require('node-fetch');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const XAI_KEY = process.env.XAI_API_KEY;

app.use(express.static('public'));

app.get('/api/qrcode', async (req, res) => {
  const text = req.query.text;
  if (!text) return res.status(400).send('Missing text param');

  try {
    const png = await QRCode.toBuffer(text, { width: 240, margin: 1 });
    res.set('Content-Type', 'image/png');
    res.send(png);
  } catch (err) {
    res.status(500).send('QR generation failed');
  }
});

// rooms: code -> { users: Map<userId, { socketId, language, connected, disconnectedAt }> }
const rooms = new Map();
const MAX_ROOM_SIZE = 20;
const GRACE_MS = 5 * 60 * 1000; // how long a dropped connection can rejoin before losing its slot / the room is torn down

// key `${roomCode}:${userId}` -> timeout that finalizes removal once the grace period lapses
const cleanupTimers = new Map();

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function connectedUsers(room) {
  return [...room.users.values()].filter(u => u.connected);
}

function languageBreakdown(room) {
  const counts = new Map();
  connectedUsers(room).forEach(u => counts.set(u.language, (counts.get(u.language) || 0) + 1));
  return [...counts.entries()].map(([language, count]) => ({ language, count }));
}

function broadcastParticipants(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  io.to(roomCode).emit('participants-updated', {
    count: connectedUsers(room).length,
    languages: languageBreakdown(room)
  });
}

function cancelCleanup(roomCode, userId) {
  const key = `${roomCode}:${userId}`;
  clearTimeout(cleanupTimers.get(key));
  cleanupTimers.delete(key);
}

function scheduleCleanup(roomCode, userId) {
  const key = `${roomCode}:${userId}`;
  clearTimeout(cleanupTimers.get(key));
  cleanupTimers.set(key, setTimeout(() => {
    cleanupTimers.delete(key);
    const room = rooms.get(roomCode);
    if (!room) return;
    const user = room.users.get(userId);
    if (!user || user.connected) return; // they reconnected in the meantime

    room.users.delete(userId);
    if (room.users.size === 0) {
      rooms.delete(roomCode);
    } else {
      broadcastParticipants(roomCode);
    }
  }, GRACE_MS));
}

function removeUserImmediately(roomCode, userId) {
  cancelCleanup(roomCode, userId);
  const room = rooms.get(roomCode);
  if (!room) return;
  room.users.delete(userId);
  if (room.users.size === 0) {
    rooms.delete(roomCode);
  } else {
    broadcastParticipants(roomCode);
  }
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUserId = null;
  let userLanguage = null;

  socket.on('create-room', ({ language, userId }, callback) => {
    const code = generateCode();
    rooms.set(code, {
      users: new Map([[userId, { socketId: socket.id, language, connected: true, disconnectedAt: null }]])
    });
    socket.join(code);
    currentRoom = code;
    currentUserId = userId;
    userLanguage = language;
    callback({ code });
  });

  socket.on('join-room', ({ code, language, userId }, callback) => {
    const roomCode = code.toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return callback({ error: 'Room not found' });
    if (room.users.size >= MAX_ROOM_SIZE) return callback({ error: 'Room is full' });

    room.users.set(userId, { socketId: socket.id, language, connected: true, disconnectedAt: null });
    socket.join(roomCode);
    currentRoom = roomCode;
    currentUserId = userId;
    userLanguage = language;

    callback({
      success: true,
      myLanguage: language,
      count: connectedUsers(room).length,
      languages: languageBreakdown(room)
    });
    broadcastParticipants(roomCode);
  });

  // fired when a client that still remembers a room (e.g. its tab was backgrounded and
  // the socket dropped) reconnects — reclaims its slot instead of registering as new
  socket.on('rejoin-room', ({ code, userId }, callback) => {
    const roomCode = (code || '').toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return callback({ error: 'Room not found' });
    const user = room.users.get(userId);
    if (!user) return callback({ error: 'Room not found' });

    user.socketId = socket.id;
    user.connected = true;
    user.disconnectedAt = null;
    socket.join(roomCode);
    currentRoom = roomCode;
    currentUserId = userId;
    userLanguage = user.language;
    cancelCleanup(roomCode, userId);

    callback({
      success: true,
      myLanguage: user.language,
      count: connectedUsers(room).length,
      languages: languageBreakdown(room)
    });
    broadcastParticipants(roomCode);
  });

  // explicit "Leave" click — remove the slot right away rather than waiting out the grace period
  socket.on('leave-room', () => {
    if (!currentRoom || !currentUserId) return;
    removeUserImmediately(currentRoom, currentUserId);
    currentRoom = null;
    currentUserId = null;
    userLanguage = null;
  });

  socket.on('audio', async ({ audio }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const roomUsers = connectedUsers(room);
    if (roomUsers.length < 2) return;

    const others = roomUsers.filter(u => u.socketId !== socket.id);
    if (others.length === 0) return;

    try {
      const transcript = await transcribe(audio);
      if (!transcript) return;

      // listeners who already speak the same language just get the raw audio, no translation needed
      const sameLanguage = others.filter(u => u.language === userLanguage);
      sameLanguage.forEach(u => {
        io.to(u.socketId).emit('audio-received', {
          audio,
          mimeType: 'audio/webm',
          original: transcript,
          translated: transcript
        });
      });

      // translate + speak once per unique target language, then fan out to everyone listening in that language
      const targetLanguages = [...new Set(others.map(u => u.language).filter(l => l !== userLanguage))];

      for (const targetLanguage of targetLanguages) {
        const translated = await translate(transcript, userLanguage, targetLanguage);
        if (!translated) continue;

        const ttsAudio = await textToSpeech(translated, targetLanguage, pickVoiceId(userLanguage, targetLanguage));
        const payload = {
          audio: ttsAudio.toString('base64'),
          mimeType: 'audio/mpeg',
          original: transcript,
          translated
        };

        others
          .filter(u => u.language === targetLanguage)
          .forEach(u => io.to(u.socketId).emit('audio-received', payload));
      }

      socket.emit('my-transcript', { text: transcript });
    } catch (err) {
      console.error('Pipeline error:', err.message);
      socket.emit('pipeline-error', { message: 'Translation failed, please try again' });
    }
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !currentUserId) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const user = room.users.get(currentUserId);
    // a newer connection (rejoin) may have already claimed this slot — don't clobber it
    if (!user || user.socketId !== socket.id) return;

    user.connected = false;
    user.disconnectedAt = Date.now();
    broadcastParticipants(currentRoom);
    scheduleCleanup(currentRoom, currentUserId);
  });
});

async function transcribe(base64Audio) {
  const audioBuffer = Buffer.from(base64Audio, 'base64');
  const form = new FormData();
  form.append('file', audioBuffer, { filename: 'audio.webm', contentType: 'audio/webm' });

  const res = await fetch('https://api.x.ai/v1/stt', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${XAI_KEY}`, ...form.getHeaders() },
    body: form
  });

  if (!res.ok) throw new Error(`xAI STT error: ${await res.text()}`);
  const data = await res.json();
  return data.text || null;
}

async function translate(text, fromLang, toLang) {
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${XAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-3',
      messages: [{
        role: 'user',
        content: `Translate from ${fromLang} to ${toLang}. Return ONLY the translation with no explanation:\n\n${text}`
      }]
    })
  });

  if (!res.ok) throw new Error(`xAI translate error: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

function pickVoiceId(sourceLanguage, targetLanguage) {
  if (sourceLanguage === 'Turkish' && targetLanguage === 'English') return 'd634b6da3d3b';
  return 'ara';
}

async function textToSpeech(text, language, voiceId) {
  const langCode = LANG_CODES[language] || 'en';

  const res = await fetch('https://api.x.ai/v1/tts', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${XAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice_id: voiceId || 'ara', language: langCode })
  });

  if (!res.ok) throw new Error(`xAI TTS error: ${await res.text()}`);
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer);
}

const LANG_CODES = {
  'English': 'en', 'Arabic': 'ar', 'Spanish': 'es', 'French': 'fr',
  'German': 'de', 'Chinese': 'zh', 'Japanese': 'ja', 'Portuguese': 'pt',
  'Hindi': 'hi', 'Russian': 'ru', 'Turkish': 'tr'
};

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
