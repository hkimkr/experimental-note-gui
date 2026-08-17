const CACHE = "exp-note-v4.3.4";
const ASSETS = [
  "./index.html",
  "./app.html",
  "./app.css",
  "./sync-app.js",
  "./html2pdf.bundle.min.js",
  "./manifest.webmanifest",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/apple-touch-icon.png",
  "./assets/favicon-32.png",
  "./assets/favicon-48.png",
  "./assets/app-preview.png",
  "./assets/link-preview.png",
];

const isShellRequest = (request) => {
  if (request.mode === "navigate") return true;
  const path = new URL(request.url).pathname;
  return /\/(index\.html|app\.html|sync-app\.js)$/.test(path);
};

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  // HTML and sync-app.js must be network-first. Cache-first left a desktop on
  // an old client after the phone had already picked up a new version, so the
  // desktop kept overlaying its stale snapshot on every refresh.
  if (isShellRequest(event.request)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(event.request, copy));
      return response;
    }))
  );
});
