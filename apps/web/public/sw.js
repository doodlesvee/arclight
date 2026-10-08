/**
 * The service worker, kept deliberately small.
 *
 * Its only job is to make the app installable, so it opens in its own window
 * without browser chrome — which is what §33's "PWA" is worth on a desktop
 * media library. Chrome requires a fetch handler before it will offer to
 * install, so there has to be one.
 *
 * What it very deliberately does NOT do is cache anything from /api/. That
 * covers every media stream, thumbnail, preview and metadata response in the
 * app, and a cached copy is one that survives signing out and can be served
 * without the session cookie ever being checked — which is exactly what §29
 * forbids ("never expose media without authentication", "never expose
 * previews/thumbnails without authentication"). The Cache API is also not
 * cleared by the browser's own "clear site data" in every case, so artwork
 * put there could outlive a deliberate attempt to remove it.
 *
 * So: the built shell is precached, everything else goes to the network, and
 * an offline visit gets the shell rather than a dinosaur. An offline shell
 * with no library behind it is not much, but it is honest about why.
 */

// Bumped whenever the shell changes shape. The build fingerprints its own
// assets, so this only has to change when this file's own logic does.
const CACHE = "media-server-shell-v2";

const SHELL = ["/", "/index.html", "/favicon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Individually, and tolerantly: one 404 in this list would otherwise
      // reject the whole install and leave the app with no worker at all.
      .then((cache) =>
        Promise.all(
          SHELL.map((url) => cache.add(url).catch(() => undefined)),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Everything that is not a plain GET of our own origin's static shell goes
  // straight to the network, untouched and uncached. The /api/ check is the
  // load-bearing one; the rest are belt and braces for the same rule.
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/")
  ) {
    return;
  }

  // A navigation falls back to the cached shell when the network is gone, so
  // the app opens and can say so, rather than showing a browser error page.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match("/index.html").then((cached) => cached ?? Response.error()),
      ),
    );
    return;
  }

  // Static assets: cache first, since the build fingerprints their names and
  // a given URL's contents therefore never change.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).then((response) => {
          // Opaque and error responses are not worth storing, and storing an
          // opaque one would hide a failure behind a cache hit next time.
          if (response.ok && response.type === "basic") {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
