// Service worker — cache-first for the app shell so pages open instantly
// (and offline), network-only for Supabase so data is never stale.
const CACHE = "lpg-app-v1";
const SHELL = [
  "index.html", "dashboard.html", "delivery.html", "driversheet.html",
  "godown.html", "accounts.html", "daysheet.html", "stock.html",
  "finance.html", "operations.html", "followups.html", "settings.html",
  "css/style.css",
  "js/config.js", "js/cloud.js", "js/common.js", "js/index.js",
  "js/delivery.js", "js/driversheet.js", "js/sheetmath.js", "js/godown.js",
  "js/accounts.js", "js/broadcast.js", "js/daysheet.js", "js/dashboard.js",
  "js/stock.js", "js/finance.js", "js/operations.js", "js/followups.js",
  "js/settings.js",
  "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // data and auth always hit the network
  if (url.hostname.endsWith("supabase.co")) return;
  if (e.request.method !== "GET") return;

  // app shell: cache first, refresh in the background
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fresh = fetch(e.request)
        .then((resp) => {
          if (resp.ok && url.origin === location.origin) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return resp;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
