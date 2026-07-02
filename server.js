require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fetch = require('node-fetch');
const WebSocket = require('ws');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e6 });

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

// per-socket live-utterance state while its talk button is held: socket.id -> utterance state
const activeUtterances = new Map();

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

// tears down any in-progress live-transcription/speech session for a socket (disconnect, error, or utterance end)
function endUtterance(socketId) {
  const state = activeUtterances.get(socketId);
  if (!state) return;
  activeUtterances.delete(socketId);
  clearTimeout(state.flushTimer);
  if (state.stt) state.stt.close();
  state.ttsSessions.forEach(session => session.close());
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
    endUtterance(socket.id);
    if (!currentRoom || !currentUserId) return;
    removeUserImmediately(currentRoom, currentUserId);
    currentRoom = null;
    currentUserId = null;
    userLanguage = null;
  });

  // --- Live streaming speech pipeline ---
  // Fired the instant the talk button is pressed, before any audio exists yet. This opens the
  // STT WebSocket and the per-target-language TTS WebSockets immediately so their connection
  // setup happens in parallel with the user taking a breath and starting to talk, instead of
  // adding that setup time to the critical path once audio is ready.
  socket.on('speech-start', () => {
    if (!currentRoom || !currentUserId) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    const others = connectedUsers(room).filter(u => u.socketId !== socket.id);
    if (others.length === 0) return;

    endUtterance(socket.id); // safety: clear out any stale prior session for this socket

    const utteranceId = `${socket.id}-${Date.now()}`;
    const sameLanguageListeners = others.filter(u => u.language === userLanguage).map(u => u.socketId);
    const targetLanguages = [...new Set(others.map(u => u.language).filter(l => l !== userLanguage))];

    sameLanguageListeners.forEach(id => io.to(id).emit('speech-utterance-start', { utteranceId, sampleRate: 16000 }));
    targetLanguages.forEach(lang => {
      others.filter(u => u.language === lang)
        .forEach(u => io.to(u.socketId).emit('speech-utterance-start', { utteranceId, sampleRate: 24000 }));
    });

    const listenersByLanguage = new Map(
      targetLanguages.map(lang => [lang, others.filter(u => u.language === lang).map(u => u.socketId)])
    );

    const state = {
      utteranceId,
      sameLanguageListeners,
      targetLanguages,
      listenersByLanguage,
      ttsSessions: new Map(),   // targetLanguage -> stream handle
      translatedText: new Map(), // targetLanguage -> accumulated translated text (for the chat history bubble)
      fullText: '',
      committedLength: 0,
      flushTimer: null,
      stt: null,
      pendingTranslations: 0,
      finalizing: false
    };
    activeUtterances.set(socket.id, state);

    targetLanguages.forEach(lang => {
      const listeners = listenersByLanguage.get(lang);
      const handle = openTtsStream({
        language: lang,
        voiceId: pickVoiceId(userLanguage, lang),
        onAudioDelta: (buf) => {
          listeners.forEach(id => io.to(id).emit('speech-chunk-out', {
            utteranceId, audio: buf.toString('base64'), sampleRate: 24000
          }));
        },
        onDone: () => {
          listeners.forEach(id => io.to(id).emit('speech-utterance-done', { utteranceId }));
          maybeFinishUtterance(socket.id, utteranceId);
        },
        onError: (err) => console.error('TTS stream error:', err.message)
      });
      state.ttsSessions.set(lang, handle);
    });

    function flushPending(isFinal) {
      const state = activeUtterances.get(socket.id);
      if (!state || state.utteranceId !== utteranceId) return;

      const pendingText = state.fullText.slice(state.committedLength);
      clearTimeout(state.flushTimer);
      state.flushTimer = null;

      if (!pendingText.trim()) {
        if (isFinal) finalizeTranslations(socket.id, utteranceId);
        return;
      }
      state.committedLength = state.fullText.length;

      targetLanguages.forEach(lang => {
        state.pendingTranslations++;
        translate(pendingText, userLanguage, lang)
          .then(translated => {
            if (!translated) return;
            const current = activeUtterances.get(socket.id);
            if (!current || current.utteranceId !== utteranceId) return;
            const soFar = current.translatedText.get(lang) || '';
            current.translatedText.set(lang, soFar ? `${soFar} ${translated}` : translated);
            const session = current.ttsSessions.get(lang);
            if (session) session.sendText(translated);
          })
          .catch(err => console.error('Translate error:', err.message))
          .finally(() => {
            const current = activeUtterances.get(socket.id);
            if (current && current.utteranceId === utteranceId) {
              current.pendingTranslations--;
              if (isFinal) finalizeTranslations(socket.id, utteranceId);
            }
          });
      });

      if (isFinal && targetLanguages.length === 0) finalizeTranslations(socket.id, utteranceId);
    }

    state.stt = openSttStream({
      onPartial: (event) => {
        const current = activeUtterances.get(socket.id);
        if (!current || current.utteranceId !== utteranceId) return;
        if (typeof event.text !== 'string' || event.text.length < current.fullText.length) return;

        current.fullText = event.text;
        const pendingText = current.fullText.slice(current.committedLength);

        if (/[.!?]\s*$/.test(pendingText.trim())) {
          flushPending(false);
        } else if (pendingText.trim() && !current.flushTimer) {
          current.flushTimer = setTimeout(() => flushPending(false), 1500);
        }

        if (event.speech_final) flushPending(true);
      },
      onError: (err) => {
        console.error('STT stream error:', err.message);
        socket.emit('pipeline-error', { message: 'Live transcription failed' });
      }
    });
  });

  socket.on('speech-chunk', (buffer) => {
    const state = activeUtterances.get(socket.id);
    if (!state || !Buffer.isBuffer(buffer)) return;
    if (state.stt) state.stt.send(buffer);
    state.sameLanguageListeners.forEach(id => io.to(id).emit('speech-chunk-out', {
      utteranceId: state.utteranceId, audio: buffer.toString('base64'), sampleRate: 16000
    }));
  });

  socket.on('speech-end', () => {
    const state = activeUtterances.get(socket.id);
    if (!state) return;
    if (state.stt) state.stt.finish();
    state.sameLanguageListeners.forEach(id => io.to(id).emit('speech-utterance-done', { utteranceId: state.utteranceId }));

    // safety net: if the STT stream never reports speech_final for some reason, don't leak the session forever
    setTimeout(() => {
      const current = activeUtterances.get(socket.id);
      if (current && current.utteranceId === state.utteranceId) endUtterance(socket.id);
    }, 10000);
  });

  socket.on('disconnect', () => {
    endUtterance(socket.id);
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

// closes out an utterance once its final translation/TTS work has actually finished (not just
// when audio.done arrives) -- called both after flushing the last translation chunk and after
// each TTS session reports it's done speaking, since both need to have settled.
function finalizeUtterance(socketId, utteranceId) {
  const state = activeUtterances.get(socketId);
  if (!state || state.utteranceId !== utteranceId || state.finalizing) return;
  state.finalizing = true;
  if (state.ttsSessions.size === 0) {
    // same-language-only listeners: nothing was translated, so there's no TTS session to wait on
    endUtterance(socketId);
    return;
  }
  state.ttsSessions.forEach(session => session.finish());
}

function finalizeTranslations(socketId, utteranceId) {
  const state = activeUtterances.get(socketId);
  if (!state || state.utteranceId !== utteranceId) return;
  if (state.pendingTranslations > 0) return; // wait for in-flight translations to land first

  // chat-history text bubbles: sent once text is fully settled, even though audio for
  // translated listeners may still be streaming in for a moment longer
  io.to(socketId).emit('my-transcript', { text: state.fullText });
  state.sameLanguageListeners.forEach(id => io.to(id).emit('speech-transcript', {
    original: state.fullText, translated: state.fullText
  }));
  state.targetLanguages.forEach(lang => {
    const translated = state.translatedText.get(lang) || state.fullText;
    (state.listenersByLanguage.get(lang) || []).forEach(id => io.to(id).emit('speech-transcript', {
      original: state.fullText, translated
    }));
  });

  finalizeUtterance(socketId, utteranceId);
}

function maybeFinishUtterance(socketId, utteranceId) {
  const state = activeUtterances.get(socketId);
  if (!state || state.utteranceId !== utteranceId) return;
  const allDone = [...state.ttsSessions.values()].every(s => s.isDone());
  if (state.finalizing && allDone) endUtterance(socketId);
}

// --- xAI streaming WebSocket helpers ---

// Returns the handle synchronously (not a Promise) so the caller can start feeding it audio
// immediately -- sends are queued internally until the connection actually reports ready, so no
// chunk sent right after speech-start is ever lost while the WebSocket handshake is in flight.
function openSttStream({ onPartial, onError }) {
  const ws = new WebSocket('wss://api.x.ai/v1/stt?sample_rate=16000&encoding=pcm&interim_results=true', {
    headers: { Authorization: `Bearer ${XAI_KEY}` }
  });
  let ready = false;
  const queue = [];

  const handle = {
    send(buf) { if (ready) ws.send(buf); else queue.push(buf); },
    finish() {
      const msg = JSON.stringify({ type: 'audio.done' });
      if (ready) ws.send(msg); else queue.push(msg);
    },
    close() { try { ws.close(); } catch (e) { /* already closed */ } }
  };

  ws.on('message', (data) => {
    let event;
    try { event = JSON.parse(data.toString()); } catch (e) { return; }

    if (event.type === 'transcript.created') {
      ready = true;
      queue.forEach(item => ws.send(item));
      queue.length = 0;
    } else if (event.type === 'transcript.partial') {
      onPartial(event);
    } else if (event.type === 'error') {
      onError(new Error(event.message));
    }
  });

  ws.on('error', (err) => onError(err));

  return handle;
}

// Also returns synchronously (see openSttStream above) -- text sent right after the session is
// requested queues internally until the WebSocket is actually open.
function openTtsStream({ language, voiceId, onAudioDelta, onDone, onError }) {
  const langCode = LANG_CODES[language] || 'en';
  const params = new URLSearchParams({
    language: langCode,
    voice: voiceId || 'ara',
    codec: 'pcm',
    sample_rate: '24000'
  });
  const ws = new WebSocket(`wss://api.x.ai/v1/tts?${params.toString()}`, {
    headers: { Authorization: `Bearer ${XAI_KEY}` }
  });
  let ready = false;
  let done = false;
  const queue = [];

  const handle = {
    sendText(delta) {
      const msg = JSON.stringify({ type: 'text.delta', delta });
      if (ready) ws.send(msg); else queue.push(msg);
    },
    finish() {
      const msg = JSON.stringify({ type: 'text.done' });
      if (ready) ws.send(msg); else queue.push(msg);
    },
    isDone() { return done; },
    close() { try { ws.close(); } catch (e) { /* already closed */ } }
  };

  ws.on('open', () => {
    ready = true;
    queue.forEach(m => ws.send(m));
    queue.length = 0;
  });

  ws.on('message', (data) => {
    let event;
    try { event = JSON.parse(data.toString()); } catch (e) { return; }

    if (event.type === 'audio.delta') {
      onAudioDelta(Buffer.from(event.delta, 'base64'));
    } else if (event.type === 'audio.done') {
      done = true;
      onDone();
    } else if (event.type === 'error') {
      onError(new Error(event.message));
    }
  });

  ws.on('error', (err) => onError(err));

  return handle;
}

async function translate(text, fromLang, toLang) {
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${XAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'grok-4.20-0309-non-reasoning',
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

const LANG_CODES = {
  'English': 'en', 'Arabic': 'ar', 'Spanish': 'es', 'French': 'fr',
  'German': 'de', 'Chinese': 'zh', 'Japanese': 'ja', 'Portuguese': 'pt',
  'Hindi': 'hi', 'Russian': 'ru', 'Turkish': 'tr'
};

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
