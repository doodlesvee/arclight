/**
 * Self-destructing service worker.
 *
 * The app used to register a worker to be installable; that feature was
 * removed. A worker already installed in a browser does NOT go away on its
 * own just because the registration code is gone — it keeps serving its
 * cached shell, which is why a stopped server still appeared to "open".
 *
 * The browser re-fetches this script on its own update check (that fetch
 * bypasses the old worker), sees it changed, installs this version, and on
 * activation it unregisters itself, deletes every cache it made, and reloads
 * any open tabs so they come straight from the network from then on.
 *
 * Keep this file (don't delete it): deleting it makes /sw.js fall back to
 * index.html, and the browser then can't complete the update that removes the
 * old worker. This file can be deleted once you're sure no browser still has
 * the old worker registered.
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.registration.unregister();
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) client.navigate(client.url);
    })(),
  );
});
