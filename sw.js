/* Quest Book service worker
   - network-first for page loads: the newest HTML always wins (updates push)
   - the navigation fetch is cache-busted so GitHub Pages' CDN can't serve a
     stale index.html; every page load pulls fresh from the origin
   - fonts/icons/manifest are bundled in the repo and precached (offline-ready)
   Bump the CACHE name (e.g. "questbook-v2") whenever you want to force a
   clean refresh of every cached asset. */

const CACHE = "questbook-v5";
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

/* ─────────────────────────────────────────────────────────────────────
   Web Push: background sync for closed devices
   When another device changes data, the send-push Edge Function pings
   this registration. The SW:
     1. shows a notification,
     2. fetches the freshest payload from Supabase (using the auth session
        the app stashed for us) and caches it under /qb-latest/<userId>,
        so the next offline open has the most recent data possible.
   ──────────────────────────────────────────────────────────────────── */
const QB_LATEST_CACHE = "qb-latest-v1";
const SW_AUTH_DB = "qb-sw-auth";
const SW_AUTH_STORE = "auth";
const SW_AUTH_KEY = "session";

function swOpenAuthDB(){
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(SW_AUTH_DB, 1);
    rq.onupgradeneeded = () => { if(!rq.result.objectStoreNames.contains(SW_AUTH_STORE)) rq.result.createObjectStore(SW_AUTH_STORE); };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
async function swGetAuth(){
  const db = await swOpenAuthDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SW_AUTH_STORE, "readonly");
    const rq = tx.objectStore(SW_AUTH_STORE).get(SW_AUTH_KEY);
    rq.onsuccess = () => resolve(rq.result || null);
    rq.onerror = () => reject(rq.error);
  });
}

// Refresh a Supabase access token with the stored refresh token.
async function swRefreshToken(auth){
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", auth.refreshToken);
  const res = await fetch(auth.url + "/auth/v1/token?grant_type=refresh_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "apikey": auth.anon },
    body: body.toString()
  });
  if(!res.ok) throw new Error("token refresh failed");
  const json = await res.json();
  json.user = { id: auth.userId };
  return json;
}

// Fetch the freshest payload and stash it so an offline open sees it.
async function swFetchLatest(auth){
  if(!auth || !auth.accessToken || !auth.url) return false;
  let token = auth.accessToken;
  try{
    let res = await fetch(auth.url + "/rest/v1/user_data?select=data&user_id=eq." + auth.userId, {
      headers: {
        "apikey": auth.anon,
        "Authorization": "Bearer " + token,
        "Accept": "application/json"
      }
    });
    if(res.status === 401 && auth.refreshToken){
      const fresh = await swRefreshToken(auth);
      if(fresh && fresh.access_token){
        token = fresh.access_token;
        // Persist refreshed tokens so future pushes keep working.
        try{
          const db = await swOpenAuthDB();
          const tx = db.transaction(SW_AUTH_STORE, "readwrite");
          const store = tx.objectStore(SW_AUTH_STORE);
          const cur = await new Promise((r2, j2) => { const q = store.get(SW_AUTH_KEY); q.onsuccess = () => r2(q.result); q.onerror = () => j2(q.error); });
          if(cur){
            cur.accessToken = fresh.access_token;
            if(fresh.refresh_token) cur.refreshToken = fresh.refresh_token;
            store.put(cur, SW_AUTH_KEY);
          }
        }catch(e){}
        res = await fetch(auth.url + "/rest/v1/user_data?select=data&user_id=eq." + auth.userId, {
          headers: { "apikey": auth.anon, "Authorization": "Bearer " + token, "Accept": "application/json" }
        });
      } else {
        return false;
      }
    }
    if(!res.ok) return false;
    const json = await res.json();
    if(!json || !json.data) return false;
    const cache = await caches.open(QB_LATEST_CACHE);
    await cache.put("/qb-latest/" + auth.userId, new Response(JSON.stringify(json.data), {
      headers: { "Content-Type": "application/json" }
    }));
    // Keep the page's copy of the session in sync if it's open.
    return true;
  }catch(e){ return false; }
}

self.addEventListener("push", (e) => {
  let data = null;
  try{ data = e.data ? e.data.json() : null; }catch(_){}
  const title = (data && data.title) || "Quest Book updated";
  const body = (data && data.body) || "Your questbook changed on another device.";
  const url = (data && data.url) || "/";
  const options = {
    body,
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    data: { url, action: (data && data.action) || "open" },
    tag: "qb-sync"
  };
  // Fetch + cache fresh data in the background so an offline open is fresh.
  e.waitUntil(
    swGetAuth().then((auth) => swFetchLatest(auth).catch(()=>false))
      .then(() => self.registration.showNotification(title, options))
      .catch(() => self.registration.showNotification(title, options))
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for(const c of list){
        if("focus" in c){ c.focus(); return; }
      }
      return clients.openWindow(target);
    })
  );
});

// Allow the app to refresh the SW's auth session (e.g. right after login
// or token refresh) without waiting for a full page reload.
self.addEventListener("message", (e) => {
  if(e.data && e.data.type === "QB_SET_AUTH"){
    e.waitUntil((async () => {
      const db = await swOpenAuthDB();
      const tx = db.transaction(SW_AUTH_STORE, "readwrite");
      tx.objectStore(SW_AUTH_STORE).put(e.data.auth, SW_AUTH_KEY);
    })().catch(()=>{}));
  }
  if(e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});
