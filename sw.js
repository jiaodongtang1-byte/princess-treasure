/* 缓存优先：装到主屏之后，断网也能翻完整本书（照片和进度本来就在本机）。
   改了文件记得把 VERSION 加一，否则老缓存会被继续用。 */
const VERSION = "p41-v6";

const SHELL = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./map.js",
  "./radar.js",
  "./story.js",
  "./vendor/jsQR.js",
  "./manifest.webmanifest",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./data/地图.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // 逐个加，一个文件 404 不至于让整个安装失败
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match("./index.html"));
    })
  );
});
