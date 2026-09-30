// HTTP-level security checks against a running server (production build):
//   node test/serve-fake-upstash.js 8791
//   UPSTASH_REDIS_REST_URL=http://127.0.0.1:8791 UPSTASH_REDIS_REST_TOKEN=x npx next start -p 3100
//   BASE=http://127.0.0.1:3100 node test/http-security.js
// Calls the API the way an attacker would: no token, someone else's public id
// as the token, tokens in the URL or body, and so on — and checks caching,
// the page HTML/JS, and that nothing secret is ever exposed.
import fs from "node:fs";
import path from "node:path";

// Ids are random UUIDs and may contain digit runs by chance, and timestamps are long numbers,
// so a plain substring search for a short number would give false alarms. Look at the values
// that could really carry the number instead (skipping id / name fields).
const SKIP = new Set(["id", "playerId", "hostId", "controlsHolderId", "currentPlayerId", "code", "name", "hostName", "organizerName", "controlsHolderName", "winnerName", "at", "revealedRound", "round"]);
function carries(value, secret) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.includes(secret);
  if (typeof value === "number") return value === Number(secret);
  if (Array.isArray(value)) return value.some((v) => carries(v, secret));
  if (typeof value === "object") return Object.entries(value).some(([k, v]) => !SKIP.has(k) && carries(v, secret));
  return false;
}
const hasSecret = (r, secret) => (r.json ? carries(r.json, secret) : r.text.includes(secret));

const BASE = process.env.BASE || "http://127.0.0.1:3100";
let passed = 0;
const failures = [];
function check(cond, msg) { if (cond) passed++; else { failures.push(msg); console.log("  FAIL -", msg); } }

async function call(route, { method = "POST", body, id, token, query = "" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (id !== undefined) headers["x-player-id"] = id;
  if (token !== undefined) headers["x-player-token"] = token;
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/${route}${query}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json, ms: performance.now() - t0, cache: res.headers.get("cache-control") || "", bytes: Buffer.byteLength(text) };
}

const ROUTES = ["create", "join", "rejoin", "comeback", "guess", "pick", "skipturn", "remove", "restore", "endround", "leave", "newround", "chat"];
const seen = []; // every response text, to scan for the secret
const track = (r) => { seen.push(r.text); return r; };

console.log("== every API response is no-store (success, errors, wrong method, bad JSON) ==");
for (const route of ROUTES) {
  const bad = await fetch(`${BASE}/api/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{nope" });
  check(/no-store/.test(bad.headers.get("cache-control") || ""), `${route}: bad JSON response is no-store`);
  const empty = await call(route, {});
  check(/no-store/.test(empty.cache), `${route}: empty-body response is no-store (${empty.status})`);
  const get = await fetch(`${BASE}/api/${route}`);
  check(/no-store/.test(get.headers.get("cache-control") || ""), `${route}: wrong-method response is no-store (${get.status})`);
}
const missing = await call("state", { method: "GET", query: "?code=ZZZZZ" });
check(missing.status === 404 && /no-store/.test(missing.cache), "state 404 is no-store");

console.log("== a rotating game with a real host, played only through the API ==");
const host = (await call("create", { body: { name: "Hosty", pin: "1111", mode: "rotating", digits: 4 } })).json;
check(host.token && /^[0-9a-f]{64}$/.test(host.token), "create returns a 256-bit token");
const code = host.code;
const a = (await call("join", { body: { code, name: "Ana", pin: "2222" } })).json;
const b = (await call("join", { body: { code, name: "Boro", pin: "3333" } })).json;
const SECRET = "4715";
const pick = track(await call("pick", { body: { code, secret: SECRET }, id: host.playerId, token: host.token }));
check(pick.status === 200, "the host can pick with their token");
check(!hasSecret(pick, SECRET), "the pick response doesn't echo the number");

const hostState = await call("state", { method: "GET", query: `?code=${code}`, id: host.playerId, token: host.token });
check(hostState.json.secret === SECRET && hostState.json.isHost, "the host receives the number");
check(JSON.stringify({ ...hostState.json, secret: null }).length < hostState.text.length && !carries({ ...hostState.json, secret: null }, SECRET), "and nowhere else than the `secret` field");

const attacks = {
  "no headers at all": {},
  "host id in the URL (old style)": { query: `&playerId=${host.playerId}` },
  "host token in the URL": { query: `&token=${host.token}&playerId=${host.playerId}` },
  "host's public id as the token": { id: host.playerId, token: host.playerId },
  "host's id with Ana's real token": { id: host.playerId, token: a.token },
  "Ana's id with the host's token": { id: a.playerId, token: host.token },
  "empty token": { id: host.playerId, token: "" },
  "garbage token": { id: host.playerId, token: "x".repeat(64) },
};
for (const [label, atk] of Object.entries(attacks)) {
  const s = track(await call("state", { method: "GET", query: `?code=${code}${atk.query || ""}`, id: atk.id, token: atk.token }));
  check(s.status === 200 && s.json.me === null && s.json.secret === null && !s.json.isHost && !s.json.isControlsHolder, `state: ${label} → anonymous, no secret, no roles`);
  check(!hasSecret(s, SECRET), `state: ${label} → the number is nowhere in the response`);
  check(s.json.chat.length === 0, `state: ${label} → no chat`);
}

console.log("== every action is rejected for someone pretending to be the host ==");
const fakeHostBodies = { code, playerId: host.playerId, targetPlayerId: a.playerId, secret: "1234", guess: "1234", text: "hi", presetId: "nice-guess" };
for (const route of ["guess", "pick", "skipturn", "remove", "restore", "endround", "leave", "comeback", "newround", "chat"]) {
  for (const [label, atk] of Object.entries({ "no token": {}, "public id as token": { id: host.playerId, token: host.playerId }, "garbage": { id: host.playerId, token: "z".repeat(64) }, "Ana's token, host's id": { id: host.playerId, token: a.token } })) {
    const r = track(await call(route, { body: fakeHostBodies, id: atk.id, token: atk.token }));
    check(r.status === 401, `${route}: ${label} → 401 (got ${r.status})`);
    check(!hasSecret(r, SECRET) && !r.text.includes(host.token), `${route}: ${label} → nothing sensitive in the error`);
  }
}
const stillHost = await call("state", { method: "GET", query: `?code=${code}`, id: host.playerId, token: host.token });
check(stillHost.json.roundState === "active" && stillHost.json.secret === SECRET && stillHost.json.players.length === 3, "none of the attacks changed the game");

console.log("== responses never contain anyone's token or hash ==");
const guestState = track(await call("state", { method: "GET", query: `?code=${code}`, id: a.playerId, token: a.token }));
for (const [who, t] of [["host", host.token], ["Ana", a.token], ["Boro", b.token]]) {
  for (const s of [hostState.text, guestState.text]) check(!s.includes(t), `${who}'s token never appears in a state response`);
}
check(!/pinHash|pinSalt|tokenHash|nameLower/.test(hostState.text + guestState.text), "no private field names in state");
const rej = await call("rejoin", { body: { code, name: "Ana", pin: "2222" } });
check(Object.keys(rej.json).sort().join() === "playerId,token", "rejoin answers with only { playerId, token }");
check(!rej.text.includes(host.token) && !rej.text.includes(b.token), "and never another person's token");

console.log("== the guess loop leaks nothing to the wrong people ==");
let live = await call("state", { method: "GET", query: `?code=${code}`, id: a.playerId, token: a.token });
let g = 0;
const attempts = ["1234", "5678", "9012", "3456", "7890", "2468"];
while (live.json.roundState === "active" && g < attempts.length) {
  const cur = live.json.currentPlayerId === a.playerId ? a : b;
  const r = track(await call("guess", { body: { code, guess: attempts[g++] }, id: cur.playerId, token: cur.token }));
  check(!hasSecret(r, SECRET), "a guess response never contains the number");
  live = await call("state", { method: "GET", query: `?code=${code}`, id: a.playerId, token: a.token });
  check(live.json.secret === null, "the guessers never receive the number");
  track(live);
}

console.log("== PIN guessing is limited (parallel burst) ==");
const burst = await Promise.all(Array.from({ length: 60 }, (_, i) => call("rejoin", { body: { code, name: "Boro", pin: String(4000 + i) } })));
const wrong = burst.filter((r) => /^Wrong PIN/.test(r.json?.error || "")).length;
const locked = burst.filter((r) => r.status === 429).length;
check(wrong <= 4, `at most 4 'Wrong PIN' answers in a 60-request burst (got ${wrong})`);
check(locked >= 55, `the rest are locked out with 429 (got ${locked})`);
const rightWhileLocked = await call("rejoin", { body: { code, name: "Boro", pin: "3333" } });
check(rightWhileLocked.status === 429, "even the right PIN is refused during the lockout");

console.log("== page HTML and JavaScript bundles hold no game data or credentials ==");
const pages = [`${BASE}/`, `${BASE}/game/${code}`];
const chunkUrls = new Set();
for (const url of pages) {
  const res = await fetch(url);
  const html = await res.text();
  check(!html.includes(SECRET) && !html.includes(host.token) && !html.includes(host.playerId), `${url}: no secret, token or player id in the HTML`);
  check(!html.includes("Hosty") && !html.includes("Boro"), `${url}: no player names in the HTML`);
  for (const m of html.matchAll(/\/_next\/static\/[^"']+\.js/g)) chunkUrls.add(m[0]);
}
let scanned = 0;
for (const u of chunkUrls) {
  const js = await (await fetch(`${BASE}${u}`)).text();
  scanned++;
  check(!/UPSTASH|KV_REST_API|REDIS_URL|tokenHashes|pinHash/.test(js), `bundle ${u.slice(-30)}: no database names or private fields`);
}
console.log(`  (scanned ${scanned} script bundles from the pages)`);

// Environment values from .env must never be in anything the browser can download.
const env = {};
try {
  for (const line of fs.readFileSync(path.join(process.cwd(), ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
    if (m && m[2].length > 8) env[m[1]] = m[2];
  }
} catch {}
const staticDir = path.join(process.cwd(), ".next", "static");
function walk(dir, out = []) { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); f.isDirectory() ? walk(p, out) : out.push(p); } return out; }
let files = 0;
if (fs.existsSync(staticDir)) {
  for (const f of walk(staticDir)) {
    const txt = fs.readFileSync(f, "utf8");
    files++;
    for (const [k, v] of Object.entries(env)) if (txt.includes(v)) check(false, `${k} value found in client file ${f}`);
    if (/NEXT_PUBLIC_[A-Z_]*(UPSTASH|KV|REDIS)/.test(txt)) check(false, `NEXT_PUBLIC database variable in ${f}`);
  }
  check(true, `client files scanned: ${files}, none hold a .env value`);
}
check(!Object.keys(process.env).concat(Object.keys(env)).some((k) => /^NEXT_PUBLIC_.*(UPSTASH|KV|REDIS)/.test(k)), "no NEXT_PUBLIC_ variable for the database");

console.log("== response size / timing: host vs guest ==");
async function sample(who) {
  const times = []; const sizes = [];
  for (let i = 0; i < 25; i++) { const r = await call("state", { method: "GET", query: `?code=${code}`, id: who.playerId, token: who.token }); times.push(r.ms); sizes.push(r.bytes); }
  times.sort((x, y) => x - y);
  return { median: times[12].toFixed(1), size: sizes[0] };
}
// A fresh active round so the host has a secret to carry.
const stats = { host: await sample(host), guest: await sample(a) };
console.log("  host:", stats.host, " guest:", stats.guest);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => "- " + f).join("\n")); process.exit(1); }
