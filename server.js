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

// rooms: code -> { users: [{ id, language }], peerLanguage }
const rooms = new Map();

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let userLanguage = null;

  socket.on('create-room', ({ language, peerLanguage }, callback) => {
    const code = generateCode();
    rooms.set(code, { users: [{ id: socket.id, language }], peerLanguage });
    socket.join(code);
    currentRoom = code;
    userLanguage = language;
    callback({ code });
  });

  socket.on('join-room', ({ code }, callback) => {
    const roomCode = code.toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return callback({ error: 'Room not found' });
    if (room.users.length >= 2) return callback({ error: 'Room is full' });

    const language = room.peerLanguage;
    room.users.push({ id: socket.id, language });
    socket.join(roomCode);
    currentRoom = roomCode;
    userLanguage = language;

    const creator = room.users[0];
    socket.to(roomCode).emit('peer-joined', { language });
    callback({ success: true, myLanguage: language, peerLanguage: creator.language });
  });

  socket.on('audio', async ({ audio, targetLanguage }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.users.length < 2) return;

    try {
      const transcript = await transcribe(audio);
      if (!transcript) return;

      const translated = await translate(transcript, userLanguage, targetLanguage);
      if (!translated) return;

      const ttsAudio = await textToSpeech(translated, targetLanguage);

      socket.to(currentRoom).emit('translated-audio', {
        audio: ttsAudio.toString('base64'),
        transcript: translated,
        original: transcript
      });

      socket.emit('my-transcript', { text: transcript, translated });
    } catch (err) {
      console.error('Pipeline error:', err.message);
      socket.emit('pipeline-error', { message: 'Translation failed, please try again' });
    }
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const updated = room.users.filter(u => u.id !== socket.id);
    if (updated.length === 0) {
      rooms.delete(currentRoom);
    } else {
      room.users = updated;
      io.to(currentRoom).emit('peer-left');
    }
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

async function textToSpeech(text, language) {
  const langCode = LANG_CODES[language] || 'en';

  const res = await fetch('https://api.x.ai/v1/tts', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${XAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice_id: 'ara', language: langCode })
  });

  if (!res.ok) throw new Error(`xAI TTS error: ${await res.text()}`);
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer);
}

const LANG_CODES = {
  'English': 'en', 'Arabic': 'ar', 'Spanish': 'es', 'French': 'fr',
  'German': 'de', 'Chinese': 'zh', 'Japanese': 'ja', 'Portuguese': 'pt',
  'Hindi': 'hi', 'Russian': 'ru'
};

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
