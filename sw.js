// WK Loft Jobs offline cache. Version changes with every app update.
const CACHE = "wk-jobs-ae1f3248";
const CORE = ["./", "index.html", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/favicon-32.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const r = e.request; if (r.method !== "GET") return;
  const u = new URL(r.url);
  if (u.origin === location.origin){
    // App files: use the network if it answers within 3 seconds, otherwise the saved copy,
    // so a weak signal never leaves the app stuck on its start screen.
    const saved = () => caches.match(r, {ignoreSearch:true}).then(m => m || caches.match("index.html"));
    const net = fetch(r).then(res => { if (res.ok){ const c = res.clone(); caches.open(CACHE).then(k => k.put(r, c)); } return res; });
    e.respondWith(new Promise(done => {
      let settled = false; const finish = x => { if (!settled){ settled = true; done(x); } };
      const t = setTimeout(() => saved().then(m => { if (m) finish(m); }), 3000);
      net.then(res => { if (res.ok) { clearTimeout(t); finish(res); } else saved().then(m => finish(m || res)); })
         .catch(() => { clearTimeout(t); saved().then(m => finish(m || Response.error())); });
    }));
  } else if (u.hostname.endsWith("fonts.googleapis.com") || u.hostname.endsWith("fonts.gstatic.com")){
    // Fonts: saved copy first; if not saved and the network is slow, carry on without them.
    e.respondWith(caches.match(r).then(m => m || Promise.race([
      fetch(r).then(res => { if (res.ok){ const c = res.clone(); caches.open(CACHE).then(k => k.put(r, c)); } return res; }),
      new Promise(ok => setTimeout(() => ok(new Response("", {status: 200, headers: {"Content-Type": u.hostname.endsWith("googleapis.com") ? "text/css" : "font/woff2"}})), 2500))
    ]).catch(() => new Response("", {status: 200, headers: {"Content-Type": "text/css"}}))));
  }
});
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch(err){ d = {title: "WK Loft Jobs", body: e.data ? e.data.text() : ""}; }
  e.waitUntil(self.registration.showNotification(d.title || "WK Loft Jobs", {body: d.body || "", tag: d.tag || "wk", renotify: true, icon: "icons/icon-192.png", badge: "icons/badge-96.png", data: {url: new URL(d.url || "./#day", self.registration.scope).href}}));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./#day";
  e.waitUntil(self.clients.matchAll({type:"window", includeUncontrolled:true}).then(cs => { for (const c of cs){ if ("focus" in c) return c.focus(); } return self.clients.openWindow(url); }));
});
