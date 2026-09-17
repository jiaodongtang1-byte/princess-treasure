/* 缓存优先：装到主屏之后，断网也能翻完整本书（照片和进度本来就在本机）。
   改了文件记得把 VERSION 加一，否则老缓存会被继续用。 */
const VERSION = "p41-v7";

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
      // 整体装：缺一个文件就整个装不上、旧版继续用。原先逐个吞错，缺了 story.js 也照样激活，断网冷启动白屏。
      // cache: "reload" 绕过 HTTP 缓存（GitHub Pages 给 max-age=600），否则 10 分钟内连推两次，新版本号里装的是旧文件
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
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
