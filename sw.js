// App-shell cache so the app opens offline. Drive/Google requests always go to the network.
const CACHE = "fishing-drive-v2";
const SHELL = [
  "./",
  "index.html",
  "config.js",
  "manifest.webmanifest",
  "src/app.js",
  "src/model.js",
  "src/csv.js",
  "src/drive.js",
  "src/store.js",
  "src/styles.css",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/favicon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  // network first (fresh code when online), cache fallback when offline
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
