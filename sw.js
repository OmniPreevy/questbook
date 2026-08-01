/* Quest Book service worker
   - network-first for page loads: the newest HTML always wins (updates push)
   - cache-first for Google Fonts: fast, repeatable loads
   - stale-while-revalidate for icons/manifest
   Bump the CACHE name (e.g. "questbook-v2") whenever you want to force a
   clean refresh of every cached asset. */

const CACHE = "questbook-v1";
const APP_URL = "./index.html";
const FONT_ORIGINS = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"];

async function precache(){
  const cache = await caches.open(CACHE);
  const urls = [APP_URL, "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];
  for(const u of urls){
    try{ await cache.add(u); }catch(e){}
  }
  try{
    const res = await fetch(APP_URL);
    if(res.ok) await cache.put("./", res.clone());
  }catch(e){}
}

self.addEventListener("install", (e) => {
  e.waitUntil(precache());
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener("message", (e) => {
  if(e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  if(FONT_ORIGINS.indexOf(url.origin) !== -1){
    // cache-first for fonts
    e.respondWith(
      caches.match(e.request).then((cached) => cached || fetch(e.request).then((res) => {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
        return res;
      }))
    );
    return;
  }

  if(e.request.mode === "navigate"){
    // network-first so updates arrive on every load; fall back to cache offline
    e.respondWith(
      fetch(e.request).then((res) => {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
        return res;
      }).catch(() => caches.match(e.request).then((c) => c || caches.match("./")))
    );
    return;
  }

  // stale-while-revalidate for everything else
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fresh = fetch(e.request).then((res) => {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
        return res;
      }).catch(() => cached);
      return cached || fresh;
    })
  );
});
