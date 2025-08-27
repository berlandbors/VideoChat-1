let drone, room, pc, localStream;
let currentChannelId = '', currentRoomName = '';

const statusEl   = document.getElementById('status');
const statusText = document.getElementById('statusText');
const statusDot  = document.getElementById('statusDot');
const loginForm  = document.getElementById('loginForm');
const remoteVideo = document.getElementById('remoteVideo');
const localVideo  = document.getElementById('localVideo');
const controls    = document.getElementById('controls');
const roomInfo    = document.getElementById('roomInfo');
const currentRoomNameSpan = document.getElementById('currentRoomName');

const config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

/* ---------- UI helpers ---------- */
function setStatus(text, color){
  statusText.textContent = text;
  statusDot.style.background = color || 'gray';
  // Прокинем реальную высоту бейджа в CSS-переменную (для позиционирования #roomInfo)
  requestAnimationFrame(() => {
    const h = statusEl.offsetHeight || 44;
    document.documentElement.style.setProperty('--status-h', h + 'px');
  });
}

function ensurePiPSize(){
  const w = localVideo.videoWidth || 0;
  const h = localVideo.videoHeight || 0;
  if (w < 2 || h < 2){
    localVideo.style.width = '160px';
    localVideo.style.height = '110px';
  }
}

/* ---------- Draggable PiP ---------- */
function makeDraggable(el){
  let sx=0, sy=0, ex=0, ey=0, dragging=false;
  const clamp = (v,min,max)=>Math.min(Math.max(v,min), max);

  function onDown(e){
    dragging = true;
    const p = e.touches ? e.touches[0] : e;
    sx = p.clientX; sy = p.clientY;
    const r = el.getBoundingClientRect();
    ex = r.left; ey = r.top;
    el.style.transition = 'none';
    e.preventDefault();
  }
  function onMove(e){
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
  function onUp(){ dragging=false; el.style.transition=''; }

  el.addEventListener('mousedown', onDown);
  el.addEventListener('touchstart', onDown, {passive:false});
  window.addEventListener('mousemove', onMove, {passive:false});
  window.addEventListener('touchmove', onMove, {passive:false});
  window.addEventListener('mouseup', onUp);
  window.addEventListener('touchend', onUp);
}

/* ---------- Init ---------- */
async function initializeChat(){
  currentChannelId = document.getElementById('channelId').value.trim();
  currentRoomName = document.getElementById('roomName').value.trim();
  if (!currentChannelId || !currentRoomName) return alert('Введите Channel ID и комнату');

  statusEl.classList.remove('hidden');
  controls.classList.remove('hidden');
  roomInfo.classList.remove('hidden');
  remoteVideo.classList.remove('hidden');

  currentRoomNameSpan.textContent = currentRoomName;
  setStatus('Запрос доступа к камере/микрофону...', 'gray');

  try{
    localVideo.muted = true;
    localVideo.playsInline = true;

    localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
    localVideo.srcObject = localStream;

    localVideo.onloadedmetadata = () => {
      localVideo.play().catch(()=>{});
      ensurePiPSize();

      // Подстроим aspect-ratio под реальную камеру (делает PiP правильной высоты на планшетах)
      const ratio = (localVideo.videoWidth && localVideo.videoHeight)
        ? (localVideo.videoWidth / localVideo.videoHeight)
        : (4/3);
      document.documentElement.style.setProperty('--pip-aspect', ratio);

      localVideo.classList.remove('hidden');
      makeDraggable(localVideo);
    };

    // Если размер меняется (орентация/переключение камер) — обновим aspect
    localVideo.addEventListener('resize', () => {
      if (localVideo.videoWidth && localVideo.videoHeight) {
        const r = localVideo.videoWidth / localVideo.videoHeight;
        document.documentElement.style.setProperty('--pip-aspect', r);
      }
    });

    loginForm.classList.add('hidden');
    setStatus('Нажмите 📞 чтобы начать звонок', 'gray');
  }catch(err){
    console.error(err);
    alert('Нет доступа к камере/микрофону');
    setStatus('Ошибка доступа к устройствам', 'red');
  }
}

/* ---------- Helpers ---------- */
function copyRoomName(){
  navigator.clipboard.writeText(currentRoomName).then(()=>{
    const btn = document.getElementById('copyRoomBtn');
    const t = btn.textContent;
    btn.textContent = '✓ Скопировано';
    setTimeout(()=> btn.textContent = t, 2000);
  });
}
function shareRoom(){
  const shareUrl = `${location.origin}${location.pathname}?room=${encodeURIComponent(currentRoomName)}`;
  navigator.clipboard.writeText(shareUrl).then(()=>{
    const btn = document.getElementById('shareRoomBtn');
    const t = btn.textContent;
    btn.textContent = '✓ Ссылка скопирована';
    setTimeout(()=> btn.textContent = t, 2000);
  });
}

/* ---------- ScaleDrone + WebRTC ---------- */
function startCall(){
  setStatus('Подключение...', 'orange');

  drone = new ScaleDrone(currentChannelId);
  const roomKey = 'observable-' + currentRoomName;

  drone.on('open', error => {
    if (error) { console.error(error); setStatus('Ошибка подключения к ScaleDrone', 'red'); return; }

    room = drone.subscribe(roomKey);

    // Как только пришёл список участников — определяем Offerer
    room.on('members', members => {
      const isOfferer = members.length === 2;
      startWebRTC(isOfferer, roomKey);
    });

    room.on('open', e => { if (e) console.error(e); });
  });
}

function sendMessage(roomKey, message){
  if (!drone) return;
  drone.publish({ room: roomKey, message });
}

function startWebRTC(isOfferer, roomKey){
  pc = new RTCPeerConnection(config);

  // локальные треки
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  // ICE кандидаты → через ScaleDrone
  pc.onicecandidate = e => {
    if (e.candidate) sendMessage(roomKey, { candidate: e.candidate });
  };

  // Пришёл удалённый трек
  pc.ontrack = e => {
    const stream = e.streams[0];
    if (!remoteVideo.srcObject || remoteVideo.srcObject.id !== stream.id) {
      remoteVideo.srcObject = stream;
      setStatus('Соединение установлено', 'green');
    }
  };

  // Offerer создаёт оффер на negotiationneeded
  if (isOfferer) {
    pc.onnegotiationneeded = () => {
      pc.createOffer().then(localDescCreated).catch(console.error);
    };
  }

  // Cигналинг
  room.on('data', (message, client) => {
    if (client.id === drone.clientId) return; // пропускаем свои

    if (message.sdp) {
      pc.setRemoteDescription(new RTCSessionDescription(message.sdp), () => {
        if (pc.remoteDescription.type === 'offer') {
          pc.createAnswer().then(localDescCreated).catch(console.error);
        }
      }, console.error);
    } else if (message.candidate) {
      pc.addIceCandidate(new RTCIceCandidate(message.candidate)).catch(console.error);
    }
  });

  function localDescCreated(desc){
    pc.setLocalDescription(desc, () => {
      sendMessage(roomKey, { sdp: pc.localDescription });
    }, console.error);
  }
}

/* ---------- Завершение, mute/cam ---------- */
function endCall(){
  if (pc) { pc.close(); pc = null; }
  if (drone) { drone.close(); drone = null; }
  remoteVideo.srcObject = null;
  setStatus('Звонок завершён', 'red');
}

function toggleMic(){
  const t = localStream?.getAudioTracks?.()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  document.getElementById('micButton').classList.toggle('toggled', !t.enabled);
}

function toggleCam(){
  const t = localStream?.getVideoTracks?.()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  document.getElementById('camButton').classList.toggle('toggled', !t.enabled);
}

window.addEventListener('beforeunload', endCall);

/* автозаполнение из ?room= */
window.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get('room');
  if (roomParam) document.getElementById('roomName').value = roomParam;
});