// WK Loft Jobs offline cache. Version changes with every app update.
const CACHE = "wk-jobs-fd1eec30";
const CORE = ["./", "index.html", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/favicon-32.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const r = e.request; if (r.method !== "GET") return;
  const u = new URL(r.url);
  if (u.origin === location.origin){
    // app files: try the network first so updates arrive, fall back to the saved copy offline
    e.respondWith(fetch(r).then(res => { const c = res.clone(); caches.open(CACHE).then(k => k.put(r, c)); return res; }).catch(() => caches.match(r, {ignoreSearch:true}).then(m => m || caches.match("index.html"))));
  } else if (u.hostname.endsWith("fonts.googleapis.com") || u.hostname.endsWith("fonts.gstatic.com")){
    e.respondWith(caches.match(r).then(m => m || fetch(r).then(res => { const c = res.clone(); caches.open(CACHE).then(k => k.put(r, c)); return res; })));
  }
});
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch(err){ d = {title: "WK Loft Jobs", body: e.data ? e.data.text() : ""}; }
  e.waitUntil(self.registration.showNotification(d.title || "WK Loft Jobs", {body: d.body || "", tag: d.tag || "wk", renotify: true, icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: {url: new URL(d.url || "./#day", self.registration.scope).href}}));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./#day";
  e.waitUntil(self.clients.matchAll({type:"window", includeUncontrolled:true}).then(cs => { for (const c of cs){ if ("focus" in c) return c.focus(); } return self.clients.openWindow(url); }));
});
