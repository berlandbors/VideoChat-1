// ======= Globals =======
let drone, room, pc, localStream;
let currentChannelId = '', currentRoomName = '';
let isStarting = false;       // защита от повторного старта
let pipDragBound = false;     // чтобы не вешать drag-листенеры повторно
let remoteStreamTimer = null;

const DEBUG = true;
const log = (...a) => DEBUG && console.log('[RTC]', ...a);

// ======= UI refs =======
const statusEl    = document.getElementById('status');
const statusText  = document.getElementById('statusText');
const statusDot   = document.getElementById('statusDot');
const loginForm   = document.getElementById('loginForm');
const remoteVideo = document.getElementById('remoteVideo');
const localVideo  = document.getElementById('localVideo');
const controls    = document.getElementById('controls');
const roomInfo    = document.getElementById('roomInfo');
const currentRoomNameSpan = document.getElementById('currentRoomName');

// ======= ICE config (добавь свой TURN при возможности) =======
const config = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    // РЕКОМЕНДАЦИЯ: раскомментируй и заполни свой TURN для сложных сетей:
    // {
    //   urls: [
    //     'turn:turn.yourdomain.com:3478?transport=udp',
    //     'turn:turn.yourdomain.com:3478?transport=tcp',
    //     'turns:turn.yourdomain.com:443?transport=tcp'
    //   ],
    //   username: 'user',
    //   credential: 'pass'
    // }
  ]
};

// ========== UI helpers ==========
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

// ========== Draggable PiP ==========
function makeDraggable(el) {
  let sx = 0, sy = 0, ex = 0, ey = 0, dragging = false;
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

// ========== Init ==========
async function initializeChat() {
  currentChannelId = document.getElementById('channelId').value.trim();
  currentRoomName  = document.getElementById('roomName').value.trim();
  if (!currentChannelId || !currentRoomName) {
    alert('Введите Channel ID и комнату');
    return;
  }

  statusEl.classList.remove('hidden');
  controls.classList.remove('hidden');
  roomInfo.classList.remove('hidden');
  remoteVideo.classList.remove('hidden');

  currentRoomNameSpan.textContent = currentRoomName;
  setStatus('Запрос доступа к камере/микрофону...', 'gray');

  try {
    localVideo.muted = true;
    localVideo.playsInline = true;

    // Улучшенные гейны/шумодав и фронталка по умолчанию
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });

    localVideo.srcObject = localStream;

    localVideo.onloadedmetadata = () => {
      localVideo.play().catch(() => {});
      ensurePiPSize();

      // Подгоняем aspect-ratio под реальную камеру
      const ratio = (localVideo.videoWidth && localVideo.videoHeight)
        ? (localVideo.videoWidth / localVideo.videoHeight)
        : (4 / 3);
      document.documentElement.style.setProperty('--pip-aspect', ratio);

      if (!pipDragBound) { makeDraggable(localVideo); pipDragBound = true; }
      localVideo.classList.remove('hidden');
    };

    // Реагируем на изменение размеров (ориентация/камера)
    localVideo.addEventListener('resize', () => {
      if (localVideo.videoWidth && localVideo.videoHeight) {
        const r = localVideo.videoWidth / localVideo.videoHeight;
        document.documentElement.style.setProperty('--pip-aspect', r);
      }
    });

    loginForm.classList.add('hidden');
    setStatus('Нажмите 📞 чтобы начать звонок', 'gray');
  } catch (e) {
    console.error(e);
    let msg = 'Нет доступа к камере/микрофону.';
    if (e.name === 'NotAllowedError')      msg = 'Разреши камеру/микрофон в настройках браузера.';
    else if (e.name === 'NotFoundError')   msg = 'Камера/микрофон не найдены.';
    else if (e.name === 'NotReadableError') msg = 'Устройство занято другой программой.';
    else if (e.name === 'OverconstrainedError') msg = 'Запрошенные параметры медиа недоступны.';
    alert(msg);
    setStatus(msg, 'red');
  }
}

// ========== Helpers ==========
function copyRoomName() {
  navigator.clipboard.writeText(currentRoomName).then(() => {
    const btn = document.getElementById('copyRoomBtn');
    const t = btn.textContent;
    btn.textContent = '✓ Скопировано';
    setTimeout(() => btn.textContent = t, 2000);
  });
}

function shareRoom() {
  const shareUrl = `${location.origin}${location.pathname}?room=${encodeURIComponent(currentRoomName)}`;
  navigator.clipboard.writeText(shareUrl).then(() => {
    const btn = document.getElementById('shareRoomBtn');
    const t = btn.textContent;
    btn.textContent = '✓ Ссылка скопирована';
    setTimeout(() => btn.textContent = t, 2000);
  });
}

// ========== ScaleDrone + WebRTC ==========
function startCall() {
  // мягкий перезапуск, если старое соединение осталось
  if (pc) { endCall(); }
  if (isStarting) return;
  isStarting = true;

  setStatus('Подключение...', 'orange');

  drone = new ScaleDrone(currentChannelId);
  const roomKey = 'observable-' + currentRoomName;

  drone.on('open', error => {
    if (error) {
      console.error(error);
      setStatus('Ошибка подключения к ScaleDrone', 'red');
      isStarting = false;
      return;
    }

    room = drone.subscribe(roomKey);

    room.on('open', e => { if (e) console.error(e); });

    // лимит: 2 участника
    room.on('members', members => {
      log('members', members);
      if (members.length > 2) {
        setStatus('Комната занята (макс 2)', 'red');
        isStarting = false;
        return;
      }
      const isOfferer = members.length === 2;
      startWebRTC(isOfferer, roomKey);
      isStarting = false;
    });

    // если собеседник вышел
    room.on('member_leave', member => {
      log('member_leave', member);
      setStatus('Собеседник вышел', 'red');
      if (pc) { try { pc.close(); } catch {} pc = null; }
      remoteVideo.srcObject = null;
    });
  });
}

function sendMessage(roomKey, message) {
  if (!drone) return;
  drone.publish({ room: roomKey, message });
}

function startWebRTC(isOfferer, roomKey) {
  pc = new RTCPeerConnection(config);

  // --- Статусы соединения / ICE ---
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    log('connectionState:', s);
    if (s === 'connected')       setStatus('Соединение установлено', 'green');
    else if (s === 'connecting') setStatus('Подключение...', 'orange');
    else if (s === 'disconnected') {
      setStatus('Связь прерывается, пытаемся восстановить…', 'orange');
      pc.restartIce?.();
    } else if (s === 'failed') {
      setStatus('Связь потеряна', 'red');
    }
  };
  pc.oniceconnectionstatechange = () => {
    log('iceConnectionState:', pc.iceConnectionState);
    if (pc.iceConnectionState === 'failed') {
      pc.restartIce?.();
      setStatus('Связь не установлена. Возможно, нужен TURN.', 'red');
    }
  };

  // --- Трансиверы и приоритет H.264 ---
  try {
    const videoTransceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
    const audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });

    const caps = RTCRtpSender.getCapabilities && RTCRtpSender.getCapabilities('video');
    if (caps && videoTransceiver.setCodecPreferences) {
      const h264 = caps.codecs.find(c => /H264/i.test(c.mimeType));
      if (h264) {
        const ordered = [h264, ...caps.codecs.filter(c => c !== h264)];
        videoTransceiver.setCodecPreferences(ordered);
        log('Prefer H264');
      }
    }

    // Привяжем локальные треки к отправителям
    const vTrack = localStream.getVideoTracks()[0];
    const aTrack = localStream.getAudioTracks()[0];
    if (vTrack) videoTransceiver.sender.replaceTrack(vTrack);
    if (aTrack) audioTransceiver.sender.replaceTrack(aTrack);
  } catch (e) {
    log('transceivers error (fallback to addTrack)', e);
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  // --- ICE кандидаты → через ScaleDrone ---
  pc.onicecandidate = e => {
    if (e.candidate) {
      sendMessage(roomKey, { candidate: e.candidate });
      log('ice candidate sent');
    }
  };

  // --- Таймаут ожидания удалённого потока (на случай "подвисшего" ICE) ---
  if (remoteStreamTimer) clearTimeout(remoteStreamTimer);
  remoteStreamTimer = setTimeout(() => {
    setStatus('Не видно собеседника (сетевые ограничения?)', 'red');
  }, 15000);

  // --- Ремоут поток ---
  pc.ontrack = e => {
    clearTimeout(remoteStreamTimer);
    const stream = e.streams[0];
    if (!remoteVideo.srcObject || remoteVideo.srcObject.id !== stream.id) {
      remoteVideo.srcObject = stream;
      setStatus('Соединение установлено', 'green');
      log('remote stream attached');
    }
  };

  // --- Offerer инициирует оффер ---
  if (isOfferer) {
    pc.onnegotiationneeded = () => {
      pc.createOffer().then(localDescCreated).catch(err => {
        console.error(err);
        setStatus('Ошибка оффера', 'red');
      });
    };
  }

  // --- Сигналинг через ScaleDrone ---
  room.on('data', (message, client) => {
    if (client.id === drone.clientId) return; // свои пропускаем

    if (message.sdp) {
      log('sdp received', message.sdp.type);
      pc.setRemoteDescription(new RTCSessionDescription(message.sdp), () => {
        if (pc.remoteDescription.type === 'offer') {
          pc.createAnswer().then(localDescCreated).catch(err => {
            console.error(err);
            setStatus('Ошибка ответа (answer)', 'red');
          });
        }
      }, err => {
        console.error(err);
        setStatus('Ошибка установки remoteDescription', 'red');
      });
    } else if (message.candidate) {
      pc.addIceCandidate(new RTCIceCandidate(message.candidate))
        .then(() => log('ice candidate added'))
        .catch(err => {
          console.error(err);
          setStatus('Ошибка ICE-кандидата', 'red');
        });
    }
  });

  function localDescCreated(desc) {
    pc.setLocalDescription(desc, () => {
      sendMessage(roomKey, { sdp: pc.localDescription });
      log('localDescription sent', pc.localDescription.type);
    }, err => {
      console.error(err);
      setStatus('Ошибка setLocalDescription', 'red');
    });
  }
}

// ========== Завершение и переключатели ==========
function endCall() {
  try { if (pc) { pc.onicecandidate = null; pc.ontrack = null; pc.close(); } } catch {}
  pc = null;

  // Попробуем отписаться от комнаты (если SDK поддерживает)
  try { if (room && room.unsubscribe) room.unsubscribe(); } catch {}
  room = null;

  try { if (drone) { drone.close(); } } catch {}
  drone = null;

  if (remoteStreamTimer) { clearTimeout(remoteStreamTimer); remoteStreamTimer = null; }

  remoteVideo.srcObject = null;
  setStatus('Звонок завершён', 'red');
  isStarting = false;

  // Если нужно полностью освободить устройства — раскомментируй:
  // if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; localVideo.srcObject = null; }
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

// Переключение фронталка/основная камера
async function switchCamera() {
  try {
    const curTrack = localStream?.getVideoTracks?.()[0];
    const curMode = curTrack?.getSettings?.().facingMode || 'user';
    const next = (curMode === 'user') ? 'environment' : 'user';

    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: next, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    const newTrack = newStream.getVideoTracks()[0];

    // Меняем трек в отправителе, если соединение уже есть
    const sender = pc?.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) await sender.replaceTrack(newTrack);

    // Обновляем локальный стрим/видео
    if (curTrack) { localStream.removeTrack(curTrack); curTrack.stop(); }
    localStream.addTrack(newTrack);
    localVideo.srcObject = localStream;

    // Обновим aspect-ratio
    const applyRatio = () => {
      const r = (localVideo.videoWidth && localVideo.videoHeight)
        ? (localVideo.videoWidth / localVideo.videoHeight)
        : (4/3);
      document.documentElement.style.setProperty('--pip-aspect', r);
    };
    if (localVideo.readyState >= 2) applyRatio();
    else localVideo.onloadedmetadata = applyRatio;

  } catch (e) {
    console.error(e);
    setStatus('Не удалось переключить камеру', 'red');
  }
}

window.addEventListener('beforeunload', endCall);

// Автоподстановка из ?room= и автофокус
window.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get('room');
  if (roomParam) document.getElementById('roomName').value = roomParam;
  document.getElementById('channelId')?.focus();

  // (опционально) автозвонок по ссылке:
  // if (roomParam) { initializeChat().then(() => startCall()); }
});