/* =========================================================
   VideoChat+ — script.js
   WebRTC + ScaleDrone + Text Chat + PWA + Notifications
   ========================================================= */

let drone, room, pc, localStream;
let currentChannelId = '', currentRoomName = '';
let roomKey = '';
let isChatOpen = false;
let unreadCount = 0;
let typingTimer = null;
let isTyping = false;
let peerOnline = false;
let currentFacingMode = 'user'; // 'user' | 'environment'

/* ── DOM refs ── */
const statusEl   = document.getElementById('status');
const statusText = document.getElementById('statusText');
const statusDot  = document.getElementById('statusDot');
const loginForm  = document.getElementById('loginForm');
const remoteVideo = document.getElementById('remoteVideo');
const localVideo  = document.getElementById('localVideo');
const controls    = document.getElementById('controls');
const roomInfo    = document.getElementById('roomInfo');
const currentRoomNameSpan = document.getElementById('currentRoomName');
const chatPanel   = document.getElementById('chatPanel');
const chatMessages = document.getElementById('chatMessages');
const typingIndicator = document.getElementById('typingIndicator');
const chatInput   = document.getElementById('chatInput');
const unreadBadge = document.getElementById('unreadBadge');
const peerStatusIndicator = document.getElementById('peerStatusIndicator');

const config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const MAX_HISTORY = 100;

/* =========================================================
   SETTINGS (localStorage)
   ========================================================= */
function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem('videochat_settings')) || {};
  } catch { return {}; }
}
function saveSettings(patch) {
  const s = { soundEnabled: true, notificationsEnabled: true, chatOpenByDefault: false, ...loadSettings(), ...patch };
  localStorage.setItem('videochat_settings', JSON.stringify(s));
  return s;
}

/* =========================================================
   CHAT HISTORY (localStorage)
   ========================================================= */
function getRoomHistory(roomName) {
  try {
    const data = JSON.parse(localStorage.getItem('videochat_room_' + roomName));
    return data && Array.isArray(data.messages) ? data : { messages: [], lastAccess: Date.now() };
  } catch { return { messages: [], lastAccess: Date.now() }; }
}
function saveRoomHistory(roomName, messages) {
  const trimmed = messages.slice(-MAX_HISTORY);
  localStorage.setItem('videochat_room_' + roomName, JSON.stringify({ messages: trimmed, lastAccess: Date.now() }));
}
function addToHistory(roomName, entry) {
  const data = getRoomHistory(roomName);
  data.messages.push(entry);
  saveRoomHistory(roomName, data.messages);
}

/* =========================================================
   UI HELPERS
   ========================================================= */
function setStatus(text, color) {
  statusText.textContent = text;
  statusDot.style.background = color || 'gray';
  requestAnimationFrame(() => {
    const h = statusEl.offsetHeight || 44;
    document.documentElement.style.setProperty('--status-h', h + 'px');
  });
}

function ensurePiPSize() {
  const w = localVideo.videoWidth || 0;
  const h = localVideo.videoHeight || 0;
  if (w < 2 || h < 2) {
    localVideo.style.width = '160px';
    localVideo.style.height = '110px';
  }
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}

/* ── Update unread badge ── */
function setUnread(n) {
  unreadCount = n;
  unreadBadge.textContent = n > 99 ? '99+' : n;
  unreadBadge.classList.toggle('hidden', n === 0);
}

/* ── Peer online indicator ── */
function setPeerOnline(online) {
  peerOnline = online;
  peerStatusIndicator.textContent = online ? '🟢' : '⚪';
  peerStatusIndicator.title = online ? 'Собеседник онлайн' : 'Собеседник оффлайн';
}

/* =========================================================
   DRAGGABLE PiP
   ========================================================= */
function makeDraggable(el) {
  let sx=0, sy=0, ex=0, ey=0, dragging=false;
  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

  function onDown(e) {
    dragging = true;
    const p = e.touches ? e.touches[0] : e;
    sx = p.clientX; sy = p.clientY;
    const r = el.getBoundingClientRect();
    ex = r.left; ey = r.top;
    el.style.transition = 'none';
    e.preventDefault();
  }
  function onMove(e) {
    if (!dragging) return;
    const p = e.touches ? e.touches[0] : e;
    const dx = p.clientX - sx;
    const dy = p.clientY - sy;
    const vw = window.innerWidth, vh = window.innerHeight;
    const r = el.getBoundingClientRect();
    const nx = clamp(ex + dx, 4, vw - r.width - 4);
    const ny = clamp(ey + dy, 4, vh - r.height - 4);
    el.style.left = nx + 'px';
    el.style.top  = ny + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }
  function onUp() { dragging = false; el.style.transition = ''; }

  el.addEventListener('mousedown', onDown);
  el.addEventListener('touchstart', onDown, { passive: false });
  window.addEventListener('mousemove', onMove, { passive: false });
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('mouseup', onUp);
  window.addEventListener('touchend', onUp);
}

/* =========================================================
   SOUNDS (Web Audio API)
   ========================================================= */
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

function playTone(freq, duration, type = 'sine', vol = 0.3) {
  const settings = loadSettings();
  if (settings.soundEnabled === false) return;
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    osc.type = type;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch (e) { /* audio not available */ }
}

function playMessageSound() {
  playTone(880, 0.12, 'sine', 0.25);
}

function playCallSound() {
  // Two ascending beeps
  playTone(440, 0.15, 'square', 0.2);
  setTimeout(() => playTone(550, 0.15, 'square', 0.2), 200);
  setTimeout(() => playTone(660, 0.15, 'square', 0.2), 400);
}

function playJoinSound() {
  playTone(600, 0.1, 'sine', 0.2);
  setTimeout(() => playTone(800, 0.1, 'sine', 0.2), 120);
}

/* =========================================================
   NOTIFICATIONS (Notification API)
   ========================================================= */
async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    alert('Ваш браузер не поддерживает уведомления.');
    return;
  }
  const perm = await Notification.requestPermission();
  const btn = document.getElementById('notifBtn');
  if (perm === 'granted') {
    saveSettings({ notificationsEnabled: true });
    btn.classList.add('active-btn');
    btn.title = 'Уведомления включены';
    showNotification('VideoChat+', 'Уведомления включены ✓');
  } else {
    saveSettings({ notificationsEnabled: false });
    btn.classList.remove('active-btn');
    btn.title = 'Уведомления отключены';
  }
}

function showNotification(title, body, tag = 'videochat') {
  const settings = loadSettings();
  if (settings.notificationsEnabled === false) return;
  if (Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return; // skip if tab is visible
  new Notification(title, { body, icon: 'icons/icon-192.png', tag });
}

function updateNotifButton() {
  const btn = document.getElementById('notifBtn');
  if (!btn) return;
  if (Notification.permission === 'granted') {
    btn.classList.add('active-btn');
    btn.title = 'Уведомления включены';
  }
}

/* =========================================================
   CHAT PANEL
   ========================================================= */
function toggleChat() {
  isChatOpen = !isChatOpen;
  chatPanel.classList.toggle('hidden', !isChatOpen);
  const btn = document.getElementById('chatToggleBtn');
  btn.classList.toggle('active-btn', isChatOpen);
  if (isChatOpen) {
    setUnread(0);
    scrollChatToBottom();
    chatInput.focus();
  }
}

function scrollChatToBottom() {
  requestAnimationFrame(() => {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });
}

/* ── Render a single message bubble ── */
function renderMessage(entry) {
  const div = document.createElement('div');
  const isMe = entry.sender === 'me';
  div.className = 'msg ' + (isMe ? 'msg-me' : 'msg-peer');

  const textNode = document.createElement('div');
  textNode.textContent = entry.text;

  const timeNode = document.createElement('div');
  timeNode.className = 'msg-time';
  timeNode.textContent = formatTime(entry.timestamp);

  div.appendChild(textNode);
  div.appendChild(timeNode);
  chatMessages.appendChild(div);
}

/* ── Render a system notice ── */
function renderSystem(text) {
  const div = document.createElement('div');
  div.className = 'msg msg-system';
  div.textContent = text;
  chatMessages.appendChild(div);
}

/* ── Load room history into chat ── */
function loadChatHistory() {
  chatMessages.innerHTML = '';
  const data = getRoomHistory(currentRoomName);
  data.messages.forEach(m => renderMessage(m));
  scrollChatToBottom();
}

/* ── Handle incoming text message ── */
function handleIncomingMessage(msg) {
  const entry = {
    text: msg.text,
    sender: 'peer',
    timestamp: msg.timestamp || Date.now(),
    read: isChatOpen
  };
  addToHistory(currentRoomName, entry);
  renderMessage(entry);
  scrollChatToBottom();

  if (!isChatOpen) {
    setUnread(unreadCount + 1);
    showNotification('VideoChat+ — Новое сообщение', msg.text, 'msg');
    playMessageSound();
  }
}

/* ── Send text message ── */
function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text || !drone) return;

  const msg = {
    type: 'text',
    text,
    sender: drone.clientId,
    timestamp: Date.now()
  };
  drone.publish({ room: roomKey, message: msg });

  const entry = { text, sender: 'me', timestamp: msg.timestamp, read: true };
  addToHistory(currentRoomName, entry);
  renderMessage(entry);
  scrollChatToBottom();

  chatInput.value = '';
  chatInput.style.height = 'auto';

  // Cancel typing indicator
  sendTypingIndicator(false);
}

/* ── Typing indicator ── */
function sendTypingIndicator(typing) {
  if (!drone || isTyping === typing) return;
  isTyping = typing;
  drone.publish({
    room: roomKey,
    message: { type: 'typing', sender: drone.clientId, isTyping: typing }
  });
}

/* ── Auto-resize textarea + typing indicators ── */
function setupChatInput() {
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  chatInput.addEventListener('input', () => {
    // auto-resize
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 100) + 'px';

    // typing indicator
    if (chatInput.value.trim()) {
      sendTypingIndicator(true);
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => sendTypingIndicator(false), 2000);
    } else {
      sendTypingIndicator(false);
    }
  });
}

/* =========================================================
   INIT
   ========================================================= */
async function initializeChat() {
  currentChannelId = document.getElementById('channelId').value.trim();
  currentRoomName  = document.getElementById('roomName').value.trim();
  if (!currentChannelId || !currentRoomName) return alert('Введите Channel ID и комнату');

  roomKey = 'observable-' + currentRoomName;

  statusEl.classList.remove('hidden');
  controls.classList.remove('hidden');
  roomInfo.classList.remove('hidden');
  remoteVideo.classList.remove('hidden');

  currentRoomNameSpan.textContent = currentRoomName;
  setStatus('Запрос доступа к камере/микрофону...', 'gray');

  const settings = loadSettings();
  if (settings.chatOpenByDefault) toggleChat();
  updateNotifButton();

  try {
    localVideo.muted = true;
    localVideo.playsInline = true;

    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;

    localVideo.onloadedmetadata = () => {
      localVideo.play().catch(() => {});
      ensurePiPSize();
      const ratio = (localVideo.videoWidth && localVideo.videoHeight)
        ? (localVideo.videoWidth / localVideo.videoHeight)
        : (4 / 3);
      document.documentElement.style.setProperty('--pip-aspect', ratio);
      localVideo.classList.remove('hidden');
      makeDraggable(localVideo);
    };

    localVideo.addEventListener('resize', () => {
      if (localVideo.videoWidth && localVideo.videoHeight) {
        const r = localVideo.videoWidth / localVideo.videoHeight;
        document.documentElement.style.setProperty('--pip-aspect', r);
      }
    });

    loginForm.classList.add('hidden');
    setStatus('Нажмите 📞 чтобы начать звонок', 'gray');

    // Load chat history and open panel
    loadChatHistory();
    setupChatInput();

    // Request notification permissions on first start
    if (!('notificationsAsked' in sessionStorage)) {
      sessionStorage.setItem('notificationsAsked', '1');
      if (Notification.permission === 'default') {
        setTimeout(requestNotificationPermission, 1500);
      }
    }
  } catch (err) {
    console.error(err);
    alert('Нет доступа к камере/микрофону');
    setStatus('Ошибка доступа к устройствам', 'red');
  }
}

/* =========================================================
   HELPERS (room copy / share)
   ========================================================= */
function copyRoomName() {
  navigator.clipboard.writeText(currentRoomName).then(() => {
    const btn = document.getElementById('copyRoomBtn');
    const t = btn.textContent;
    btn.textContent = '✓ Скопировано';
    setTimeout(() => btn.textContent = t, 2000);
  });
}

function shareRoom() {
  const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(currentRoomName)}`;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('shareRoomBtn');
    const t = btn.textContent;
    btn.textContent = '✓ Ссылка скопирована';
    setTimeout(() => btn.textContent = t, 2000);
  });
}

/* =========================================================
   ScaleDrone + WebRTC
   ========================================================= */
function startCall() {
  setStatus('Подключение...', 'orange');
  playCallSound();

  drone = new ScaleDrone(currentChannelId);

  drone.on('open', error => {
    if (error) { console.error(error); setStatus('Ошибка подключения к ScaleDrone', 'red'); return; }

    room = drone.subscribe(roomKey);

    room.on('members', members => {
      const isOfferer = members.length === 2;
      if (isOfferer) {
        setPeerOnline(true);
        renderSystem('Собеседник в комнате');
        showNotification('VideoChat+', 'Собеседник подключился к комнате');
        playJoinSound();
      }
      startWebRTC(isOfferer);
    });

    room.on('member_join', member => {
      if (member.id === drone.clientId) return;
      setPeerOnline(true);
      renderSystem('Собеседник присоединился');
      scrollChatToBottom();
      showNotification('VideoChat+', 'Собеседник присоединился к комнате');
      playJoinSound();
    });

    room.on('member_leave', member => {
      if (member.id === drone.clientId) return;
      setPeerOnline(false);
      renderSystem('Собеседник покинул комнату');
      scrollChatToBottom();
      showNotification('VideoChat+', 'Собеседник покинул комнату');
      typingIndicator.classList.add('hidden');
    });

    room.on('open', e => { if (e) console.error(e); });
  });
}

function sendSignal(message) {
  if (!drone) return;
  drone.publish({ room: roomKey, message });
}

function startWebRTC(isOfferer) {
  pc = new RTCPeerConnection(config);

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.onicecandidate = e => {
    if (e.candidate) sendSignal({ candidate: e.candidate });
  };

  pc.ontrack = e => {
    const stream = e.streams[0];
    if (!remoteVideo.srcObject || remoteVideo.srcObject.id !== stream.id) {
      remoteVideo.srcObject = stream;
      setStatus('Соединение установлено', 'green');
      showNotification('VideoChat+', 'Видеосвязь установлена');
    }
  };

  if (isOfferer) {
    pc.onnegotiationneeded = () => {
      pc.createOffer().then(localDescCreated).catch(console.error);
    };
  }

  /* ── Route incoming messages by type ── */
  room.on('data', (message, client) => {
    if (client.id === drone.clientId) return; // skip own messages

    // Text chat messages
    if (message.type === 'text') {
      handleIncomingMessage(message);
      return;
    }

    // Typing indicator
    if (message.type === 'typing') {
      typingIndicator.classList.toggle('hidden', !message.isTyping);
      if (message.isTyping) scrollChatToBottom();
      return;
    }

    // WebRTC signaling (sdp / candidate)
    if (message.sdp) {
      pc.setRemoteDescription(new RTCSessionDescription(message.sdp), () => {
        if (pc.remoteDescription.type === 'offer') {
          pc.createAnswer().then(localDescCreated).catch(console.error);
        }
      }, console.error);
      return;
    }
    if (message.candidate) {
      pc.addIceCandidate(new RTCIceCandidate(message.candidate)).catch(console.error);
    }
  });

  function localDescCreated(desc) {
    pc.setLocalDescription(desc, () => {
      sendSignal({ sdp: pc.localDescription });
    }, console.error);
  }
}

/* =========================================================
   CALL CONTROLS
   ========================================================= */
function endCall() {
  if (pc) { pc.close(); pc = null; }
  if (drone) { drone.close(); drone = null; }
  remoteVideo.srcObject = null;
  setPeerOnline(false);
  typingIndicator.classList.add('hidden');
  renderSystem('Звонок завершён');
  scrollChatToBottom();
  setStatus('Звонок завершён', 'red');
}

function toggleMic() {
  const t = localStream?.getAudioTracks?.()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  document.getElementById('micButton').classList.toggle('toggled', !t.enabled);
}

function toggleCam() {
  const t = localStream?.getVideoTracks?.()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  document.getElementById('camButton').classList.toggle('toggled', !t.enabled);
}

/* ── Switch front/back camera ── */
async function switchCamera() {
  if (!localStream) return;

  currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';

  const btn = document.getElementById('switchCamBtn');
  btn.disabled = true;

  try {
    // Stop current video track
    localStream.getVideoTracks().forEach(t => t.stop());

    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: currentFacingMode },
      audio: false
    });
    const newTrack = newStream.getVideoTracks()[0];

    // Replace track in PeerConnection
    if (pc) {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);
    }

    // Add new track to localStream and update preview
    localStream.addTrack(newTrack);
    localVideo.srcObject = localStream;
  } catch (err) {
    console.error('switchCamera error:', err);
    // Revert facing mode on error
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
  } finally {
    btn.disabled = false;
  }
}

/* =========================================================
   SERVICE WORKER REGISTRATION
   ========================================================= */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          // Notify user of available update (non-intrusive)
          console.info('VideoChat+: новая версия приложения доступна. Перезагрузите страницу.');
        }
      });
    });
  }).catch(err => console.warn('SW registration failed:', err));
}

/* =========================================================
   BOOTSTRAP
   ========================================================= */
window.addEventListener('DOMContentLoaded', () => {
  // Auto-fill room from URL param
  const roomParam = new URLSearchParams(window.location.search).get('room');
  if (roomParam) document.getElementById('roomName').value = roomParam;

  // Register service worker
  registerServiceWorker();
});

window.addEventListener('beforeunload', endCall);
