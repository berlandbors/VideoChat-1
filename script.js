// ===== Глобальные переменные =====
let drone = null, room = null, pc = null, localStream = null;
let currentChannelId = '', currentRoomName = '', roomKey = '';
let makingOffer = false, ignoreOffer = false, polite = false;

const statusEl   = document.getElementById('status');
const statusText = document.getElementById('statusText');
const statusDot  = document.getElementById('statusDot');
const loginForm  = document.getElementById('loginForm');
const remoteVideo = document.getElementById('remoteVideo');
const localVideo  = document.getElementById('localVideo');
const controls    = document.getElementById('controls');
const roomInfo    = document.getElementById('roomInfo');
const currentRoomNameSpan = document.getElementById('currentRoomName');

// STUN + заготовка под TURN
const configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    // Рекомендуется добавить свой TURN для надёжности:
    // {
    //   urls: [
    //     'turn:YOUR_TURN_HOST:3478?transport=udp',
    //     'turn:YOUR_TURN_HOST:3478?transport=tcp'
    //   ],
    //   username: 'turn_user',
    //   credential: 'turn_pass'
    // }
  ]
};

// ===== Утилиты UI =====
function setStatus(text, color){
  statusText.textContent = text;
  statusDot.style.background = color || 'gray';
  statusEl.classList.remove('hidden');

  // Прокинем реальную высоту бейджа в CSS-переменную (для отступа блока Комнаты)
  requestAnimationFrame(() => {
    const h = statusEl.offsetHeight || 44;
    document.documentElement.style.setProperty('--status-h', h + 'px');
  });
}

function ensurePiPSize(){
  const w = localVideo.videoWidth || 0;
  const h = localVideo.videoHeight || 0;
  if (w < 2 || h < 2){
    // задаём только ширину — высота посчитается через aspect-ratio
    localVideo.style.width = '160px';
    localVideo.style.height = '';
  }
}

// Перетаскивание PiP
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

// ===== Инициализация (форма) =====
async function initializeChat(){
  currentChannelId = document.getElementById('channelId').value.trim();
  currentRoomName = document.getElementById('roomName').value.trim();

  if (!currentChannelId || !currentRoomName) {
    alert('Введите Channel ID и комнату');
    return;
  }

  roomKey = 'observable-' + currentRoomName;

  statusEl.classList.remove('hidden');
  controls.classList.remove('hidden');
  roomInfo.classList.remove('hidden');
  remoteVideo.classList.remove('hidden');

  currentRoomNameSpan.textContent = currentRoomName;
  setStatus('Запрос доступа к камере/микрофону...', 'gray');

  try{
    localVideo.muted = true;
    localVideo.playsInline = true;

    // Ранний запрос прав (реальный стрим включим в startWebRTC)
    const testStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
    testStream.getTracks().forEach(t => t.stop());

    loginForm.classList.add('hidden');
    setStatus('Нажмите 📞 чтобы начать звонок', 'gray');
  }catch(err){
    console.error(err);
    alert('Нет доступа к камере/микрофону');
    setStatus('Ошибка доступа к устройствам', 'red');
  }
}

// Копирование и шаринг
function copyRoomName(){
  navigator.clipboard.writeText(currentRoomName).then(()=>{
    const btn = document.getElementById('copyRoomBtn');
    const t = btn.textContent;
    btn.textContent = '✓ Скопировано';
    setTimeout(()=> btn.textContent = t, 2000);
  });
}

async function shareRoom(){
  const shareUrl = `${location.origin || ''}${location.pathname}?room=${encodeURIComponent(currentRoomName)}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'Видеочат', url: shareUrl }); return; }
    catch(e){ /* fallback ниже */ }
  }
  await navigator.clipboard.writeText(shareUrl);
  const btn = document.getElementById('shareRoomBtn');
  const t = btn.textContent;
  btn.textContent = '✓ Ссылка скопирована';
  setTimeout(()=> btn.textContent = t, 2000);
}

// ===== Звонок: ScaleDrone + WebRTC =====
function startCall(){
  setStatus('Подключение...', 'orange');

  drone = new ScaleDrone(currentChannelId);

  drone.on('open', error => {
    if (error) { console.error(error); setStatus('Ошибка подключения к ScaleDrone', 'red'); return; }

    room = drone.subscribe(roomKey);

    room.on('open', e => { if (e) console.error(e); });

    // Когда получили список участников — определяем роль
    room.on('members', members => {
      // поддерживаем только 2-х участников
      if (members.length > 2) {
        setStatus('Комната занята (макс. 2 участника)', 'red');
        return;
      }
      // второй участник — offerer; первый — answerer (polite)
      const isOfferer = members.length === 2;
      startWebRTC(isOfferer);
    });
  });
}

function publishSignal(message){
  if (!drone) return;
  drone.publish({ room: roomKey, message });
}

async function startWebRTC(isOfferer){
  pc = new RTCPeerConnection(configuration);
  polite = !isOfferer; // второй зашёл → «вежливый»

  // Локальные медиа
  try{
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: {ideal:1280}, height:{ideal:720}, facingMode:'user' },
      audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true }
    });
    localVideo.srcObject = localStream;
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }catch(err){
    console.error('getUserMedia error:', err);
    alert('Нет доступа к камере/микрофону');
    setStatus('Ошибка доступа к устройствам', 'red');
    return;
  }

  // ICE кандидаты → через ScaleDrone
  pc.onicecandidate = e => { if (e.candidate) publishSignal({ candidate: e.candidate }); };

  // Статусы ICE
  pc.oniceconnectionstatechange = () => {
    const st = pc.iceConnectionState;
    console.log('ICE state:', st);
    if (st === 'connected') setStatus('Соединение установлено', 'green');
    else if (st === 'disconnected' || st === 'failed') setStatus('Потеря связи…', 'orange');
    else if (st === 'closed') setStatus('Звонок завершён', 'red');
  };

  // Удалённый трек
  pc.ontrack = e => {
    const stream = e.streams[0];
    if (!remoteVideo.srcObject || remoteVideo.srcObject.id !== stream.id) {
      remoteVideo.srcObject = stream;
      remoteVideo.classList.remove('hidden');
    }
  };

  // Perfect negotiation — оффер создаёт инициатор
  pc.onnegotiationneeded = async () => {
    try{
      makingOffer = true;
      await pc.setLocalDescription(await pc.createOffer());
      publishSignal({ sdp: pc.localDescription });
    }catch(e){
      console.error('negotiation error:', e);
    }finally{
      makingOffer = false;
    }
  };

  // Сигналинг от ScaleDrone
  room.on('data', async (message, client) => {
    if (client.id === drone.clientId) return; // игнорируем свои

    try{
      if (message.sdp) {
        const desc = message.sdp;
        const offerCollision = (desc.type === 'offer') &&
          (makingOffer || pc.signalingState !== 'stable');

        ignoreOffer = !polite && offerCollision;
        if (ignoreOffer) {
          console.log('Ignoring offer (not polite, collision).');
          return;
        }

        await pc.setRemoteDescription(desc);
        if (desc.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          publishSignal({ sdp: pc.localDescription });
        }
      } else if (message.candidate) {
        try { await pc.addIceCandidate(message.candidate); }
        catch (err) { if (!ignoreOffer) throw err; }
      }
    }catch(err){
      console.error('Signal handling error:', err);
    }
  });

  // Показ локального PiP
  localVideo.onloadedmetadata = () => {
    localVideo.play().catch(()=>{});
    ensurePiPSize();
    localVideo.classList.remove('hidden');
    makeDraggable(localVideo);
  };

  setStatus(isOfferer ? 'Идёт инициация звонка…' : 'Ожидание оффера…', 'gray');
}

// Завершение, mute/cam
function endCall(){
  try { if (pc) pc.close(); } catch {}
  pc = null;

  if (drone) { try { drone.close(); } catch {} drone = null; }
  room = null;

  if (remoteVideo.srcObject) {
    try { remoteVideo.srcObject.getTracks().forEach(t => t.stop()); } catch {}
    remoteVideo.srcObject = null;
  }
  if (localStream) {
    try { localStream.getTracks().forEach(t => t.stop()); } catch {}
    localStream = null;
  }

  document.getElementById('micButton')?.classList.remove('toggled');
  document.getElementById('camButton')?.classList.remove('toggled');

  setStatus('Звонок завершён', 'red');
}

function toggleMic(){
  const t = localStream?.getAudioTracks?.()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  const muted = !t.enabled;
  const btn = document.getElementById('micButton');
  btn.classList.toggle('toggled', muted);
  btn.title = muted ? 'Микрофон выключен' : 'Микрофон включен';
}

function toggleCam(){
  const t = localStream?.getVideoTracks?.()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  const off = !t.enabled;
  const btn = document.getElementById('camButton');
  btn.classList.toggle('toggled', off);
  btn.title = off ? 'Камера выключена' : 'Камера включена';
}

window.addEventListener('beforeunload', endCall);

// автозаполнение из ?room=
window.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get('room');
  if (roomParam) document.getElementById('roomName').value = roomParam;
});