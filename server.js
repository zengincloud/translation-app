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

// per-socket live-utterance state for whichever single utterance (one STT connection's worth of
// speech, ending at speech_final) is currently in progress: socket.id -> utterance state
const activeUtterances = new Map();

// tracks whether a socket's mic is still toggled on, independent of any individual utterance --
// a conversation is many utterances back-to-back (xAI's STT closes each one out at a natural
// pause), so when one finishes we check this to decide whether to transparently open the next
// one, rather than requiring the user to re-tap the button between every sentence
const micSessions = new Map(); // socket.id -> { active, roomCode, userId, language }

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

// tears down whatever utterance is CURRENTLY active for a socket, unconditionally -- for
// disconnect/leave-room, where the user is actually gone and there's no "next utterance" that
// might already be listening in its place.
function endUtterance(socketId) {
  const state = activeUtterances.get(socketId);
  if (!state) return;
  activeUtterances.delete(socketId);
  clearTimeout(state.flushTimer);
  clearTimeout(state.safetyTimer);
  if (state.stt) state.stt.close();
  state.ttsSessions.forEach(session => session.close());
}

// closes THIS utterance's own connections and removes it from activeUtterances only if the map
// still points to this exact utterance. Used when a specific utterance finishes/errors, since by
// that point the map may have already moved on to the next utterance in the same conversation
// (see beginUtterance's speech_final handling) -- naively deleting by socket id here would wipe
// out that newer, still-listening utterance instead of this finished one.
function finishState(state) {
  clearTimeout(state.flushTimer);
  clearTimeout(state.safetyTimer);
  if (state.stt) state.stt.close();
  state.ttsSessions.forEach(session => session.close());
  if (activeUtterances.get(state.socketId) === state) {
    activeUtterances.delete(state.socketId);
  }
}

// if the mic is still toggled on when an utterance finishes naturally (as opposed to an
// explicit mute or a disconnect), seamlessly opens the next one -- otherwise the user would have
// to re-tap the button between every single sentence of a conversation
function maybeContinueMicSession(socketId) {
  const micSession = micSessions.get(socketId);
  if (!micSession || !micSession.active) return;
  const socket = io.sockets.sockets.get(socketId);
  if (!socket) return;
  beginUtterance(socket, micSession.roomCode, micSession.language);
}

// Opens one utterance's worth of STT/TTS pipeline: a single continuous stretch of speech from
// when it starts until xAI's STT reports speech_final (a natural pause). A full conversation is
// many of these back-to-back while the mic stays toggled on -- see maybeContinueMicSession.
function beginUtterance(socket, roomCode, language) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const others = connectedUsers(room).filter(u => u.socketId !== socket.id);
  if (others.length === 0) return;

  const utteranceId = `${socket.id}-${Date.now()}`;
  const sameLanguageListeners = others.filter(u => u.language === language).map(u => u.socketId);
  const targetLanguages = [...new Set(others.map(u => u.language).filter(l => l !== language))];

  sameLanguageListeners.forEach(id => io.to(id).emit('speech-utterance-start', { utteranceId, sampleRate: 16000 }));
  targetLanguages.forEach(lang => {
    others.filter(u => u.language === lang)
      .forEach(u => io.to(u.socketId).emit('speech-utterance-start', { utteranceId, sampleRate: 24000 }));
  });

  const listenersByLanguage = new Map(
    targetLanguages.map(lang => [lang, others.filter(u => u.language === lang).map(u => u.socketId)])
  );

  // NOTE: every function below closes over this `state` object directly rather than re-fetching
  // it from `activeUtterances` -- that map only tracks which utterance is currently LISTENING
  // for live audio, and gets swapped to a new one the instant speech_final arrives (see below) so
  // the next utterance's STT connection is ready with no gap. This utterance's own translation
  // and TTS keep running to completion independently in the background after that swap, using
  // this closure, so they can't be short-circuited by a "is this still the current one?" check
  // that would now say no.
  const state = {
    socketId: socket.id,
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
    finalizing: false,
    // set once ANY flush has been marked final (speech_final seen) -- checked by every in-flight
    // translate() call's own completion handler instead of each call's own captured isFinal flag,
    // since a translation kicked off by an earlier non-final flush can easily still be pending
    // when speech_final arrives moments later. Using this instead of the closure-captured value
    // means whichever translation happens to finish last is always the one that notices the
    // utterance is actually done and triggers finalization -- otherwise it can fall through the
    // cracks entirely (the earlier call thinks it isn't final, the later one finds nothing new to
    // flush and just waits for a signal that never comes), leaving the utterance stuck forever
    // with no transcript ever sent and its TTS session never released.
    wantsFinalize: false,
    speechFinalHandled: false,
    translationsEmitted: false,
    // hard backstop: if this utterance's TTS session(s) never signal done or error (e.g. a
    // WebSocket that just hangs instead of closing cleanly), force it closed rather than leaking
    // an open connection for the rest of the server's life -- across a long, many-sentence
    // conversation, leaked sessions like that add up and can exhaust xAI's per-team concurrent
    // session cap, which is the likely cause of "works for a while, then just stops"
    safetyTimer: null
  };
  state.safetyTimer = setTimeout(() => finishState(state), 30000);
  activeUtterances.set(socket.id, state);

  targetLanguages.forEach(lang => {
    const listeners = listenersByLanguage.get(lang);
    const handle = openTtsStream({
      language: lang,
      voiceId: pickVoiceId(language, lang),
      onAudioDelta: (buf) => {
        listeners.forEach(id => io.to(id).emit('speech-chunk-out', {
          utteranceId, audio: buf.toString('base64'), sampleRate: 24000
        }));
      },
      onDone: () => {
        listeners.forEach(id => io.to(id).emit('speech-utterance-done', { utteranceId }));
        maybeFinishUtterance(state);
      },
      onError: (err) => {
        console.error('TTS stream error:', err.message);
        listeners.forEach(id => io.to(id).emit('pipeline-error', { message: 'Translation audio failed for this message' }));
        maybeFinishUtterance(state);
      }
    });
    state.ttsSessions.set(lang, handle);
  });

  function flushPending(isFinal) {
    const pendingText = state.fullText.slice(state.committedLength);
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
    if (isFinal) state.wantsFinalize = true;

    if (!pendingText.trim()) {
      if (isFinal) finalizeTranslations(state);
      return;
    }
    state.committedLength = state.fullText.length;

    targetLanguages.forEach(lang => {
      state.pendingTranslations++;
      translate(pendingText, language, lang)
        .then(translated => {
          if (!translated) return;
          const soFar = state.translatedText.get(lang) || '';
          state.translatedText.set(lang, soFar ? `${soFar} ${translated}` : translated);
          const session = state.ttsSessions.get(lang);
          if (session) session.sendText(translated);
        })
        .catch(err => console.error('Translate error:', err.message))
        .finally(() => {
          state.pendingTranslations--;
          if (state.wantsFinalize) finalizeTranslations(state);
        });
    });

    if (isFinal && targetLanguages.length === 0) finalizeTranslations(state);
  }

  state.stt = openSttStream({
    onPartial: (event) => {
      // once speech_final has been handled, this connection is being closed -- ignore anything
      // else it sends (a redundant re-send, or a message that was already in flight when we
      // called close()) instead of treating it as new/more speech
      if (state.speechFinalHandled) return;
      if (typeof event.text !== 'string' || event.text.length < state.fullText.length) return;

      state.fullText = event.text;
      const pendingText = state.fullText.slice(state.committedLength);

      if (/[.!?]\s*$/.test(pendingText.trim())) {
        flushPending(false);
      } else if (pendingText.trim() && !state.flushTimer) {
        state.flushTimer = setTimeout(() => flushPending(false), 1500);
      }

      if (event.speech_final && !state.speechFinalHandled) {
        // guard against xAI re-sending speech_final for this same connection (or a message
        // already in flight arriving just after we call close() below) triggering this whole
        // block a second time, which would re-translate and re-emit the same sentence
        state.speechFinalHandled = true;
        // stop listening on this connection and, if still toggled on, start the next utterance's
        // STT connection right away -- otherwise audio for the next sentence keeps arriving here
        // and is fed into a stream that already considers itself finished, which is what was
        // causing sentences to get lost or garbled mid-conversation
        if (state.stt) state.stt.close();
        if (activeUtterances.get(socket.id) === state) {
          maybeContinueMicSession(socket.id);
        }
        flushPending(true);
      }
    },
    onError: (err) => {
      console.error('STT stream error:', err.message);
      socket.emit('pipeline-error', { message: 'Live transcription failed' });
      finishState(state);
      maybeContinueMicSession(socket.id); // try to recover rather than leaving them stuck silent
    }
  });
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
    micSessions.delete(socket.id);
    if (!currentRoom || !currentUserId) return;
    removeUserImmediately(currentRoom, currentUserId);
    currentRoom = null;
    currentUserId = null;
    userLanguage = null;
  });

  // --- Live streaming speech pipeline ---
  // Fired the instant the talk button is tapped on, before any audio exists yet. This opens the
  // STT WebSocket and the per-target-language TTS WebSockets immediately so their connection
  // setup happens in parallel with the user taking a breath and starting to talk, instead of
  // adding that setup time to the critical path once audio is ready.
  socket.on('speech-start', () => {
    if (!currentRoom || !currentUserId) return;
    micSessions.set(socket.id, { active: true, roomCode: currentRoom, userId: currentUserId, language: userLanguage });
    beginUtterance(socket, currentRoom, userLanguage);
  });

  socket.on('speech-chunk', (buffer) => {
    const state = activeUtterances.get(socket.id);
    if (!state || !Buffer.isBuffer(buffer)) return;
    if (state.stt) state.stt.send(buffer);
    state.sameLanguageListeners.forEach(id => io.to(id).emit('speech-chunk-out', {
      utteranceId: state.utteranceId, audio: buffer.toString('base64'), sampleRate: 16000
    }));
  });

  // explicit mute (tapped off) -- unlike a natural pause mid-conversation, this one should NOT
  // trigger the next utterance to auto-start
  socket.on('speech-end', () => {
    const micSession = micSessions.get(socket.id);
    if (micSession) micSession.active = false;

    const state = activeUtterances.get(socket.id);
    if (!state) return;
    if (state.stt) state.stt.finish();
    state.sameLanguageListeners.forEach(id => io.to(id).emit('speech-utterance-done', { utteranceId: state.utteranceId }));

    // safety net: if the STT stream never reports speech_final for some reason, don't leak the session forever
    setTimeout(() => finishState(state), 10000);
  });

  socket.on('disconnect', () => {
    endUtterance(socket.id);
    micSessions.delete(socket.id);
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
// each TTS session reports it's done speaking, since both need to have settled. Operates on the
// state object directly (see beginUtterance) since by now activeUtterances may already point to
// a newer utterance in the same conversation.
function finalizeUtterance(state) {
  if (state.finalizing) return;
  state.finalizing = true;
  if (state.ttsSessions.size === 0) {
    // same-language-only listeners: nothing was translated, so there's no TTS session to wait on
    finishState(state);
    return;
  }
  state.ttsSessions.forEach(session => session.finish());
}

function finalizeTranslations(state) {
  if (state.pendingTranslations > 0) return; // wait for in-flight translations to land first
  // belt-and-suspenders: whatever triggers this (multiple in-flight translations completing
  // around the same time, a redundant event, etc.), the transcript/audio must only ever go out
  // to listeners once per utterance
  if (state.translationsEmitted) return;
  state.translationsEmitted = true;

  // chat-history text bubbles: sent once text is fully settled, even though audio for
  // translated listeners may still be streaming in for a moment longer
  io.to(state.socketId).emit('my-transcript', { text: state.fullText });
  state.sameLanguageListeners.forEach(id => io.to(id).emit('speech-transcript', {
    original: state.fullText, translated: state.fullText
  }));
  state.targetLanguages.forEach(lang => {
    const translated = state.translatedText.get(lang) || state.fullText;
    (state.listenersByLanguage.get(lang) || []).forEach(id => io.to(id).emit('speech-transcript', {
      original: state.fullText, translated
    }));
  });

  finalizeUtterance(state);
}

function maybeFinishUtterance(state) {
  const allDone = [...state.ttsSessions.values()].every(s => s.isDone());
  if (state.finalizing && allDone) {
    finishState(state);
  }
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

  // guards against sending on a socket that has since closed or errored -- this can legitimately
  // happen now, since an utterance's STT connection gets closed proactively at speech_final while
  // a caller might still (harmlessly) try to use the handle for a moment afterward
  function safeSend(payload) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(payload); } catch (e) { /* socket closed between the check and the send */ }
  }

  const handle = {
    send(buf) { if (ready) safeSend(buf); else queue.push(buf); },
    finish() {
      const msg = JSON.stringify({ type: 'audio.done' });
      if (ready) safeSend(msg); else queue.push(msg);
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

  function safeSend(payload) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(payload); } catch (e) { /* socket closed between the check and the send */ }
  }

  const handle = {
    sendText(delta) {
      const msg = JSON.stringify({ type: 'text.delta', delta });
      if (ready) safeSend(msg); else queue.push(msg);
    },
    finish() {
      const msg = JSON.stringify({ type: 'text.done' });
      if (ready) safeSend(msg); else queue.push(msg);
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
      done = true; // xAI reported a failure for this session -- it won't produce audio.done either
      onError(new Error(event.message));
    }
  });

  ws.on('error', (err) => {
    done = true; // this session will never call onDone -- don't make the utterance wait forever for it
    onError(err);
  });

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
