const CACHE = "arizona-static-v24";

const IMG_CACHE = CACHE + "-img";

const STATIC = [ "/styles.css?v=6", "/ui.js?v=13", "/auth.js?v=9", "/img/logo.png", "/img/noavatar.png" ];

// Кэшируем только статику (css/js/шрифты/картинки). HTML и страницы — никогда:
// они всегда идут по сети, иначе пользователи застревают на старой версии.
const ASSET_RE = /\.(css|js|png|jpe?g|webp|gif|svg|ico|woff2?|webmanifest)$/i;

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
  // Навигация (открытие страниц) — всегда мимо SW: браузер сам ходит в сеть
  // и показывает нормальную ошибку, а не ERR_FAILED, когда сервер недоступен.
  if (req.mode === "navigate" || req.destination === "document") return;
  const isAvatar = AVATAR_RE.test(url.pathname);
  const isAsset = ASSET_RE.test(url.pathname);
  if (!isAvatar && !isAsset) return;
  // Отвечаем из SW только если есть кэш; иначе вообще не перехватываем запрос.
  e.respondWith((async () => {
    const cacheName = isAvatar ? IMG_CACHE : CACHE;
    const cache = await caches.open(cacheName);
    const cached = await cache.match(req);
    const fetchAndUpdate = fetch(req).then(res => {
      if (res && res.status === 200) cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);
    if (cached) {
      // stale-while-revalidate: отдаём кэш, сеть обновляет его в фоне
      fetchAndUpdate.catch(() => {});
      return cached;
    }
    const fresh = await fetchAndUpdate;
    if (fresh) return fresh;
    // Сети нет и кэша нет: не отвечаем(undefined)/Response.error() здесь нельзя —
    // это и давало ERR_FAILED. Бросаем ошибку = обычное поведение «сеть недоступна».
    throw new Error("offline: no cache for " + url.pathname);
  })());
});
