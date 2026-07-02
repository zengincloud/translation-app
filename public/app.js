const socket = io();

let myLanguage = 'English';
let peerLanguage = null;
let mediaRecorder = null;
let audioChunks = [];
let isConnected = false;

const $ = id => document.getElementById(id);

// --- Lobby ---

$('create-btn').addEventListener('click', () => {
  myLanguage = $('my-language').value;
  socket.emit('create-room', { language: myLanguage }, ({ code }) => {
    enterRoom(code, false);
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
    peerLanguage = res.peerLanguage;
    enterRoom(code, true);
  });
}

function showLobbyError(msg) {
  const el = $('lobby-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}

// --- Room ---

socket.on('peer-joined', ({ language }) => {
  peerLanguage = language;
  $('peer-lang-pill').textContent = language;
  $('peer-lang-pill').classList.remove('muted');
  setStatus('connected', 'Connected');
  $('talk-btn').disabled = false;
  isConnected = true;
});

socket.on('peer-left', () => {
  isConnected = false;
  peerLanguage = null;
  $('peer-lang-pill').textContent = '?';
  $('peer-lang-pill').classList.add('muted');
  setStatus('waiting', 'Peer disconnected');
  $('talk-btn').disabled = true;
});

socket.on('translated-audio', ({ audio, transcript, original }) => {
  $('processing-indicator').classList.add('hidden');
  addTranscript('them', original, transcript);
  playAudio(audio);
});

socket.on('my-transcript', ({ text, translated }) => {
  addTranscript('me', text, translated);
});

socket.on('pipeline-error', ({ message }) => {
  $('processing-indicator').classList.add('hidden');
  addSystemMessage(message);
});

// --- Push to talk ---

const talkBtn = $('talk-btn');

talkBtn.addEventListener('mousedown', startRecording);
talkBtn.addEventListener('mouseup', stopRecording);
talkBtn.addEventListener('touchstart', e => { e.preventDefault(); startRecording(); });
talkBtn.addEventListener('touchend', e => { e.preventDefault(); stopRecording(); });

async function startRecording() {
  if (!isConnected || !peerLanguage) return;

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
      socket.emit('audio', { audio: base64, targetLanguage: peerLanguage });
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

function playAudio(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'audio/mpeg' });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.play().catch(() => {});
  audio.onended = () => URL.revokeObjectURL(url);
}

function addTranscript(who, original, translated) {
  const list = $('transcript-list');
  const placeholder = list.querySelector('.placeholder');
  if (placeholder) placeholder.remove();

  const div = document.createElement('div');
  div.className = `bubble ${who}`;
  div.innerHTML = `
    <div class="bubble-original">${escapeHtml(original)}</div>
    <div class="bubble-translated">${escapeHtml(translated)}</div>
  `;
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
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

function enterRoom(code, alreadyConnected) {
  $('lobby').classList.add('hidden');
  $('room').classList.remove('hidden');
  $('room-code-display').textContent = code;
  $('my-lang-pill').textContent = myLanguage;

  if (alreadyConnected && peerLanguage) {
    $('peer-lang-pill').textContent = peerLanguage;
    $('peer-lang-pill').classList.remove('muted');
    setStatus('connected', 'Connected');
    $('talk-btn').disabled = false;
    isConnected = true;
  }
}
