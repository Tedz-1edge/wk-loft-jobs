// WK Loft Jobs traffic checker. Runs on Cloudflare Workers (free plan).
// Each morning it asks Google for the live drive time from home to the first stop
// and sends a phone notification: leave earlier, leave later, or leave as planned.
// No customer data is stored here beyond the first stop's postcode for the next few days.

const SUB = "https://tedz-1edge.github.io/wk-loft-jobs/";
const ALLOW = ["https://tedz-1edge.github.io", "http://localhost:8765"];
const enc = new TextEncoder();

/* ---------- small helpers ---------- */
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const cat = (...a) => { const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a){ out.set(x, o); o += x.length; } return out; };
const toMin = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ""); return m ? +m[1] * 60 + +m[2] : null; };
const hm = m => { m = ((Math.round(m) % 1440) + 1440) % 1440; return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };
const dur = m => m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m} min`;
function london(d = new Date()){
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"}).formatToParts(d).map(x => [x.type, x.value]));
  return {date: `${p.year}-${p.month}-${p.day}`, mins: +p.hour * 60 + +p.minute};
}
function cors(req, res){
  const o = req.headers.get("Origin");
  if (o && ALLOW.includes(o)){ res.headers.set("Access-Control-Allow-Origin", o); res.headers.set("Vary", "Origin"); }
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return res;
}
const json = (o, status = 200) => new Response(JSON.stringify(o), {status, headers: {"Content-Type": "application/json"}});

/* ---------- VAPID keys (made once, kept in KV) ---------- */
async function vapid(env){
  let v = await env.WK.get("vapid", "json");
  if (!v){
    const k = await crypto.subtle.generateKey({name: "ECDSA", namedCurve: "P-256"}, true, ["sign", "verify"]);
    v = {priv: await crypto.subtle.exportKey("jwk", k.privateKey), pub: b64u(await crypto.subtle.exportKey("raw", k.publicKey))};
    await env.WK.put("vapid", JSON.stringify(v));
  }
  return v;
}

/* ---------- Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) ---------- */
async function hkdf(salt, ikm, info, bytes){
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({name: "HKDF", hash: "SHA-256", salt, info}, k, bytes * 8));
}
export async function encryptPush(sub, payload){
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const as = await crypto.subtle.generateKey({name: "ECDH", namedCurve: "P-256"}, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, {name: "ECDH", namedCurve: "P-256"}, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({name: "ECDH", public: uaKey}, as.privateKey, 256));
  const ikm = await hkdf(auth, shared, cat(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({name: "AES-GCM", iv: nonce}, key, cat(enc.encode(payload), new Uint8Array([2]))));
  const head = new Uint8Array(21); head.set(salt); new DataView(head.buffer).setUint32(16, 4096); head[20] = 65;
  return cat(head, asPub, ct);
}
async function vapidAuth(env, endpoint){
  const v = await vapid(env);
  const key = await crypto.subtle.importKey("jwk", v.priv, {name: "ECDSA", namedCurve: "P-256"}, false, ["sign"]);
  const h = b64u(enc.encode(JSON.stringify({typ: "JWT", alg: "ES256"})));
  const p = b64u(enc.encode(JSON.stringify({aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUB})));
  const sig = await crypto.subtle.sign({name: "ECDSA", hash: "SHA-256"}, key, enc.encode(`${h}.${p}`));
  return `vapid t=${h}.${p}.${b64u(sig)}, k=${v.pub}`;
}
async function push(env, msg){
  const reg = await env.WK.get("reg", "json");
  if (!reg?.sub) return {ok: false, why: "No phone registered"};
  const body = await encryptPush(reg.sub, JSON.stringify(msg));
  const r = await fetch(reg.sub.endpoint, {method: "POST", body, headers: {
    "Authorization": await vapidAuth(env, reg.sub.endpoint), "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream", "TTL": "3600", "Urgency": "high"}});
  return {ok: r.ok, status: r.status, why: r.ok ? "" : (await r.text()).slice(0, 200)};
}

/* ---------- Google live traffic ---------- */
async function driveMins(env, from, to, when){
  const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {method: "POST", headers: {
    "Content-Type": "application/json", "X-Goog-Api-Key": env.GOOGLE_MAPS_KEY, "X-Goog-FieldMask": "routes.duration,routes.staticDuration"},
    body: JSON.stringify({origin: {address: from}, destination: {address: to}, travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE_OPTIMAL", departureTime: when.toISOString(), regionCode: "GB"})});
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.routes?.[0]) throw new Error(d.error?.message || `Google said ${r.status}`);
  return {traffic: Math.round(parseInt(d.routes[0].duration) / 60), usual: Math.round(parseInt(d.routes[0].staticDuration || d.routes[0].duration) / 60)};
}
async function advise(env, day, home, nowMins){
  const leave = toMin(day.leave);
  const wait = Math.max(1, leave - nowMins);
  const t = await driveMins(env, `${home}, UK`, `${day.dest}, UK`, new Date(Date.now() + wait * 60000));
  const diff = t.traffic - day.plannedMins, shift = Math.round(diff / 5) * 5;
  let title, body;
  if (shift >= 10){ title = `Set off ${shift} mins earlier, at ${hm(leave - shift)}`; body = `Traffic to ${day.dest} is ${dur(t.traffic)} right now. The plan allows ${dur(day.plannedMins)}.`; }
  else if (shift <= -15){ title = `Traffic is light. Leave up to ${-shift} mins later`; body = `The drive to ${day.dest} is ${dur(t.traffic)} right now. The plan allows ${dur(day.plannedMins)}, so ${hm(leave - shift)} would still get you there on time.`; }
  else { title = `Traffic looks normal. Leave at ${hm(leave)}`; body = `The drive to ${day.dest} is about ${dur(t.traffic)} right now. The plan allows ${dur(day.plannedMins)}.`; }
  return {title, body, shift, traffic: t.traffic, usual: t.usual};
}

/* ---------- the morning check ---------- */
async function morning(env){
  const plan = await env.WK.get("plan", "json"); if (!plan) return;
  const {date, mins} = london(), day = (plan.days || []).find(d => d.date === date);
  if (!day || toMin(day.leave) == null) return;
  const until = toMin(day.leave) - mins;
  // Checks run from 2h30 before leaving until just after. Bad traffic is reported as soon as it's seen;
  // otherwise the first message comes about 1h40 before leaving, so it doesn't wake you early for nothing.
  if (until > 150 || until < -15) return;
  const key = `sent-${date}`, sent = await env.WK.get(key, "json");
  const a = await advise(env, day, plan.home || "OL8 2AJ", mins);
  if (!sent && until > 100 && a.shift < 10) return;
  if (!sent){
    await push(env, {title: a.title, body: a.body, tag: key, url: "./#day"});
  } else if (Math.abs(a.shift - sent.shift) >= 10 && until > -15){
    await push(env, {title: `Traffic update: ${a.title.charAt(0).toLowerCase() + a.title.slice(1)}`, body: a.body, tag: key, url: "./#day"});
  } else return;
  await env.WK.put(key, JSON.stringify({shift: a.shift, at: Date.now()}), {expirationTtl: 2 * 86400});
}

/* ---------- web endpoints for the app ---------- */
async function handle(req, env){
  const u = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, {status: 204});
  if (req.method === "GET" && u.pathname === "/") return json({ok: true, app: "wk-traffic"});
  if (req.method === "GET" && u.pathname === "/vapid") return json({key: (await vapid(env)).pub});
  if (req.method !== "POST") return json({error: "Not found"}, 404);
  const b = await req.json().catch(() => ({}));
  if (typeof b.token !== "string" || b.token.length < 20) return json({error: "Missing token"}, 400);
  const reg = await env.WK.get("reg", "json");
  if (u.pathname === "/register"){
    // One phone owns the alerts. Another phone can take over only once the first has been quiet for 3 days.
    if (reg?.token && reg.token !== b.token && Date.now() - (reg.seen || reg.at || 0) < 3 * 86400000) return json({error: "Another phone already gets these alerts. If you've changed phone, try again in 3 days or ask Claude to reset it."}, 403);
    if (!b.sub?.endpoint || !b.sub?.keys?.p256dh || !b.sub?.keys?.auth) return json({error: "Bad subscription"}, 400);
    await env.WK.put("reg", JSON.stringify({token: b.token, sub: b.sub, at: Date.now(), seen: Date.now()}));
    return json({ok: true});
  }
  if (!reg || reg.token !== b.token) return json({error: "This phone isn't registered"}, 403);
  if (Date.now() - (reg.seen || 0) > 6 * 3600000) await env.WK.put("reg", JSON.stringify({...reg, seen: Date.now()}));
  if (u.pathname === "/plan"){
    const days = (Array.isArray(b.days) ? b.days : []).slice(0, 14).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.date) && toMin(d.leave) != null && typeof d.dest === "string")
      .map(d => ({date: d.date, leave: d.leave, dest: d.dest.slice(0, 20), plannedMins: Math.max(1, Math.min(600, Number(d.plannedMins) || 105))}));
    await env.WK.put("plan", JSON.stringify({home: String(b.home || "OL8 2AJ").slice(0, 20), days, at: Date.now()}));
    return json({ok: true, days: days.length});
  }
  if (u.pathname === "/test"){
    const plan = await env.WK.get("plan", "json"), {date, mins} = london();
    const day = (plan?.days || []).find(d => d.date >= date);
    let check = null, err = "";
    if (day){ try { check = await advise(env, day, plan.home, day.date === date ? mins : 0); } catch(e){ err = e.message; } }
    const r = await push(env, {title: "Traffic alerts are working", body: check ? `Live check for ${day.date}: ${check.title}. ${check.body}` : day ? `Couldn't check traffic: ${err}` : "You'll get a traffic check about 1h40 before you set off on each planned day.", tag: "test", url: "./#settings"});
    return json({ok: r.ok, push: r, check, error: err, next: day || null});
  }
  return json({error: "Not found"}, 404);
}

export default {
  async fetch(req, env){
    try { return cors(req, await handle(req, env)); }
    catch(e){ return cors(req, json({error: e.message}, 500)); }
  },
  async scheduled(evt, env, ctx){ ctx.waitUntil(morning(env).catch(e => console.log("morning check failed", e.message))); }
};
