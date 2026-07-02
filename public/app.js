const socket = io();

let myLanguage = 'English';
let mediaRecorder = null;
let audioChunks = [];
let isConnected = false;

const $ = id => document.getElementById(id);

// --- Lobby ---

$('create-btn').addEventListener('click', () => {
  myLanguage = $('my-language').value;

  socket.emit('create-room', { language: myLanguage }, ({ code }) => {
    enterRoom(code);
    updateParticipants(1, [{ language: myLanguage, count: 1 }]);
    showQrCode(code);
  });
});

$('join-btn').addEventListener('click', joinRoom);
$('code-input').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });

function joinRoom() {
  const code = $('code-input').value.trim().toUpperCase();
  if (code.length < 6) return showLobbyError('Enter a 6-character room code');
  myLanguage = $('my-language').value;

  socket.emit('join-room', { code, language: myLanguage }, (res) => {
    if (res.error) return showLobbyError(res.error);
    enterRoom(code);
    updateParticipants(res.count, res.languages);
  });
}

function showLobbyError(msg) {
  const el = $('lobby-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}

// --- Room ---

socket.on('participants-updated', ({ count, languages }) => {
  updateParticipants(count, languages);
});

socket.on('audio-received', ({ audio, mimeType, original, translated }) => {
  $('processing-indicator').classList.add('hidden');
  const bubble = addTranscript('them', original, translated);
  playAudio(audio, mimeType, bubble);
});

socket.on('my-transcript', ({ text }) => {
  addTranscript('me', text);
});

socket.on('pipeline-error', ({ message }) => {
  $('processing-indicator').classList.add('hidden');
  addSystemMessage(message);
});

// --- Leave room ---

$('leave-btn').addEventListener('click', leaveRoom);

function leaveRoom() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
  socket.disconnect();
  socket.connect();

  isConnected = false;
  audioChunks = [];

  $('transcript-list').innerHTML = '<div class="placeholder">Transcripts will appear here</div>';
  $('processing-indicator').classList.add('hidden');
  $('rec-indicator').classList.add('hidden');
  $('talk-btn').disabled = true;
  $('code-input').value = '';
  hideQrCode();

  $('room').classList.add('hidden');
  $('lobby').classList.remove('hidden');
}

// --- QR join code ---

function showQrCode(code) {
  const joinUrl = `${window.location.origin}/?code=${code}`;
  $('qr-code').src = `/api/qrcode?text=${encodeURIComponent(joinUrl)}`;
  $('qr-wrap').classList.remove('hidden');
}

function hideQrCode() {
  $('qr-wrap').classList.add('hidden');
  $('qr-code').src = '';
}

// --- QR join (opened via a scanned room QR link, ?code=XXXXXX) ---

function getLanguageOptions() {
  return [...document.querySelectorAll('#my-language option')].map(o => o.value);
}

function showQrJoinView(code) {
  $('qr-join-code').textContent = code;

  const grid = $('qr-join-languages');
  grid.innerHTML = '';
  getLanguageOptions().forEach(lang => {
    const btn = document.createElement('button');
    btn.className = 'lang-choice-btn';
    btn.textContent = lang;
    btn.addEventListener('click', () => joinRoomWithLanguage(code, lang));
    grid.appendChild(btn);
  });

  $('lobby').classList.add('hidden');
  $('qr-join-view').classList.remove('hidden');
}

function joinRoomWithLanguage(code, language) {
  myLanguage = language;
  socket.emit('join-room', { code, language }, (res) => {
    if (res.error) {
      const el = $('qr-join-error');
      el.textContent = res.error;
      el.classList.remove('hidden');
      return;
    }
    $('qr-join-view').classList.add('hidden');
    enterRoom(code);
    updateParticipants(res.count, res.languages);
  });
}

$('qr-join-back').addEventListener('click', () => {
  $('qr-join-view').classList.add('hidden');
  $('lobby').classList.remove('hidden');
});

(function handleIncomingQrLink() {
  const code = new URLSearchParams(window.location.search).get('code');
  history.replaceState({}, '', window.location.pathname);
  if (!code) return;
  showQrJoinView(code.toUpperCase());
})();

// --- Push to talk ---

const talkBtn = $('talk-btn');

talkBtn.addEventListener('mousedown', startRecording);
talkBtn.addEventListener('mouseup', stopRecording);
talkBtn.addEventListener('touchstart', e => { e.preventDefault(); startRecording(); });
talkBtn.addEventListener('touchend', e => { e.preventDefault(); stopRecording(); });

async function startRecording() {
  if (!isConnected) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];

    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

    mediaRecorder.ondataavailable = e => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      if (blob.size < 1000) return; // ignore empty recordings
      const base64 = await blobToBase64(blob);
      $('processing-indicator').classList.remove('hidden');
      socket.emit('audio', { audio: base64 });
    };

    mediaRecorder.start();
    talkBtn.classList.add('recording');
    $('rec-indicator').classList.remove('hidden');
  } catch (err) {
    addSystemMessage('Microphone access denied');
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    talkBtn.classList.remove('recording');
    $('rec-indicator').classList.add('hidden');
  }
}

// --- Helpers ---

function blobToBase64(blob) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.readAsDataURL(blob);
  });
}

function playAudio(base64, mimeType, bubble) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mimeType || 'audio/mpeg' });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.onended = () => URL.revokeObjectURL(url);

  audio.play().catch(() => {
    if (bubble) showPlayFallback(bubble, url);
  });
}

function showPlayFallback(bubble, url) {
  const btn = document.createElement('button');
  btn.className = 'play-fallback-btn';
  btn.textContent = '🔊 Tap to play';
  btn.addEventListener('click', () => {
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    audio.play().catch(() => {});
    btn.remove();
  }, { once: true });
  bubble.appendChild(btn);
}

function addTranscript(who, original, translated) {
  const list = $('transcript-list');
  const placeholder = list.querySelector('.placeholder');
  if (placeholder) placeholder.remove();

  const div = document.createElement('div');
  div.className = `bubble ${who}`;

  const showTranslated = translated && translated !== original;
  div.innerHTML = showTranslated
    ? `
      <div class="bubble-original">${escapeHtml(original)}</div>
      <div class="bubble-translated">${escapeHtml(translated)}</div>
    `
    : `<div class="bubble-translated">${escapeHtml(original)}</div>`;

  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
  return div;
}

function addSystemMessage(msg) {
  const list = $('transcript-list');
  const div = document.createElement('div');
  div.className = 'system-msg';
  div.textContent = msg;
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setStatus(type, text) {
  const el = $('status');
  el.className = `status ${type}`;
  el.textContent = text;
}

function updateParticipants(count, languages) {
  isConnected = count >= 2;
  $('talk-btn').disabled = !isConnected;

  if (isConnected) {
    setStatus('connected', 'Connected');
  } else {
    setStatus('waiting', 'Waiting for someone to join…');
  }

  $('participant-count').textContent = count === 1
    ? 'Just you so far'
    : `${count} in room`;

  const breakdown = $('language-breakdown');
  breakdown.innerHTML = (languages || [])
    .map(({ language, count }) => `<span class="lang-chip">${escapeHtml(language)} × ${count}</span>`)
    .join('');
}

function enterRoom(code) {
  $('lobby').classList.add('hidden');
  $('room').classList.remove('hidden');
  $('room-code-display').textContent = code;
  $('my-lang-pill').textContent = myLanguage;
}
