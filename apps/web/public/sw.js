// Service worker do EMANNU OS:
// - guarda o app (HTML, JS, CSS, ícones) para abrir mesmo com o PC desligado;
// - nunca guarda a API (os dados offline vêm do último retrato salvo pelo app);
// - recebe as notificações e abre a tela certa ao tocar.
const CACHE = 'emannu-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/favicon.ico'];

// Os arquivos do app têm hash no nome: descobre quais são lendo o index.html e
// baixa só os que ainda não estão guardados.
async function cacheAssets(cache) {
  const page = await cache.match('/');
  if (!page) return;
  const html = await page.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  for (const a of assets) if (!(await cache.match(a))) await cache.add(a);
}

async function cacheShell() {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL);
  await cacheAssets(cache);
}

self.addEventListener('install', (event) => {
  event.waitUntil(cacheShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Páginas: rede primeiro (pega a versão nova), cache se o PC estiver fora do ar.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          // Versão nova do app: guarda a página e os arquivos novos que ela usa.
          caches.open(CACHE).then((c) => c.put('/', copy).then(() => cacheAssets(c))).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }

  // Arquivos estáticos: cache primeiro.
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && url.pathname.startsWith('/assets/')) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});

self.addEventListener('push', (event) => {
  let data = { title: 'EMANNU OS', body: '', url: '/', tag: 'emannu' };
  try {
    data = { ...data, ...event.data.json() };
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      renotify: true,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (win) return win.navigate(target).then((w) => (w || win).focus());
      return self.clients.openWindow(target);
    }),
  );
});
