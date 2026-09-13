const CACHE = "arizona-static-08b6ee20d94a";

const IMG_CACHE = CACHE + "-img";

const STATIC = [ "/styles.css?v=5", "/ui.js?v=13", "/auth.js?v=8", "/img/logo.png", "/img/noavatar.png" ];

self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC).catch(() => {})));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== IMG_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("message", e => {
  if (e.data && e.data.type === "prefetch_avatars" && Array.isArray(e.data.urls)) {
    caches.open(IMG_CACHE).then(cache => {
      e.data.urls.filter(Boolean).forEach(url => {
        cache.match(url).then(hit => {
          if (!hit) cache.add(url).catch(() => {});
        });
      });
    });
  }
});

const AVATAR_RE = /^\/api\/(avatars_cache|custom_avatar)\//;

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (AVATAR_RE.test(url.pathname)) {
    e.respondWith(caches.open(IMG_CACHE).then(async cache => {
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.status === 200) cache.put(req, res.clone());
        return res;
      } catch {
        return hit || Response.error();
      }
    }));
    return;
  }
  if (url.pathname.startsWith("/api/") || url.pathname.endsWith(".html") || url.pathname === "/") return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(req);
    const network = fetch(req).then(res => {
      if (res && res.status === 200) cache.put(req, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  }));
});
