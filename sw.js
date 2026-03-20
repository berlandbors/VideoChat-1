/* VideoChat+ Service Worker v1 */
const CACHE = 'videochat-v1';
const STATIC = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/manifest.json',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Нет соединения — VideoChat+</title>
  <style>
    body{margin:0;background:#000;color:#fff;font-family:Arial,sans-serif;
         display:flex;flex-direction:column;align-items:center;justify-content:center;
         height:100vh;text-align:center;padding:20px;}
    h1{font-size:clamp(24px,5vw,40px);margin-bottom:16px;}
    p{font-size:clamp(14px,2.5vw,18px);opacity:.7;max-width:360px;}
    button{margin-top:24px;padding:12px 28px;font-size:16px;border:none;border-radius:10px;
           background:#4CAF50;color:#fff;cursor:pointer;font-weight:700;}
  </style>
</head>
<body>
  <h1>📵 Нет соединения</h1>
  <p>VideoChat+ недоступен без интернета. Проверьте подключение и попробуйте снова.</p>
  <button onclick="location.reload()">Повторить попытку</button>
</body>
</html>`;

/* ── Install: cache static assets ── */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

/* ── Activate: remove old caches ── */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* ── Fetch: Cache-First for static, Network-First for rest ── */
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Pass through non-GET requests (POST, OPTIONS, etc.) without caching
  if (e.request.method !== 'GET') {
    e.respondWith(fetch(e.request));
    return;
  }

  const isStatic = STATIC.includes(url.pathname) || url.pathname.startsWith('/icons/');
  const isScaleDrone = url.hostname.includes('scaledrone');

  if (isStatic) {
    // Cache-First
    e.respondWith(
      caches.match(e.request).then(cached =>
        cached || fetch(e.request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        }).catch(() => {
          if (e.request.headers.get('accept')?.includes('text/html')) {
            return new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html' } });
          }
        })
      )
    );
  } else if (!isScaleDrone) {
    // Network-First for other requests (e.g. navigation)
    e.respondWith(
      fetch(e.request).catch(() => {
        if (e.request.headers.get('accept')?.includes('text/html')) {
          return new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html' } });
        }
      })
    );
  }
  // ScaleDrone WebSocket/XHR — let pass through unmodified
});
