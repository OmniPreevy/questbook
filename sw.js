/* Quest Book service worker
   - network-first for page loads: the newest HTML always wins (updates push)
   - the navigation fetch is cache-busted so GitHub Pages' CDN can't serve a
     stale index.html; every page load pulls fresh from the origin
   - fonts/icons/manifest are bundled in the repo and precached (offline-ready)
   Bump the CACHE name (e.g. "questbook-v2") whenever you want to force a
   clean refresh of every cached asset. */

const CACHE = "questbook-v4";
const APP_URL = "./index.html";

async function precache(){
  const cache = await caches.open(CACHE);
  const urls = [
    APP_URL, "./manifest.webmanifest",
    "./icon-192.png", "./icon-512.png",
    "./fonts/cinzel-600.woff2", "./fonts/cinzeldec-400.woff2",
    "./fonts/cinzeldec-700.woff2", "./fonts/cinzeldec-900.woff2"
  ];
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
  if(e.request.mode === "navigate"){
    // network-first so updates arrive on every load; the version query string
    // defeats GitHub Pages' CDN cache so the freshest HTML is fetched each time
    const busted = e.request.url + (e.request.url.indexOf("?") === -1 ? "?" : "&") + "qbv=" + Date.now();
    e.respondWith(
      fetch(busted).then((res) => {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
        return res;
      }).catch(() => caches.match(e.request).then((c) => c || caches.match("./")))
    );
    return;
  }

  // stale-while-revalidate for everything else; never cache or serve error
  // responses (a stale 404 from an outage must not shadow the real file)
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const ok = cached && cached.ok;
      const fresh = fetch(e.request).then((res) => {
        if(res.ok){
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      }).catch(() => (ok ? cached : undefined));
      return (ok ? cached : undefined) || fresh;
    })
  );
});
