// Mi plan · service worker: la app abre aunque no haya cobertura.
// Cambia VERSION cuando publiques cambios para que los móviles cojan la versión nueva.
const VERSION = "mi-plan-v8";
const SHELL = ["./", "index.html", "app.js", "config.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];
const CDN = ["cdn.jsdelivr.net", "unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Datos (Supabase, Open Food Facts): siempre a la red, nunca a la caché.
  if (url.origin === location.origin) {
    // Archivos de la app: primero la red (para coger actualizaciones), si no hay red, la caché.
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match("index.html"))));
    return;
  }
  if (CDN.includes(url.hostname)) {
    // Librerías y tipografías: primero la caché.
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => {
      if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    })));
  }
});
