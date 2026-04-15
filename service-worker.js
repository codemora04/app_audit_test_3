const CACHE_NAME = "audit-final";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", () => self.clients.claim());

self.addEventListener("fetch", (event) => {
  if (event.request.url.startsWith("http")) {
    event.respondWith(fetch(event.request));
  }
});