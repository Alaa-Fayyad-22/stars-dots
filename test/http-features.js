// HTTP-level checks for the routes added with replays, the summary, ending the
// game and duels, against a running production build (same set-up as
// test/http-security.js):
//   node test/serve-fake-upstash.js 8791
//   UPSTASH_REDIS_REST_URL=http://127.0.0.1:8791 UPSTASH_REDIS_REST_TOKEN=x npx next start -p 3100
//   BASE=http://127.0.0.1:3100 node test/http-features.js
const BASE = process.env.BASE || "http://127.0.0.1:3100";
let passed = 0;
const failures = [];
function check(cond, msg) { if (cond) passed++; else { failures.push(msg); console.log("  FAIL -", msg); } }

async function call(route, { method = "POST", body, id, token, query = "", raw } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (id !== undefined) headers["x-player-id"] = id;
  if (token !== undefined) headers["x-player-token"] = token;
  const res = await fetch(`${BASE}/api/${route}${query}`, { method, headers, body: method === "GET" ? undefined : raw !== undefined ? raw : JSON.stringify(body ?? {}) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json, cache: res.headers.get("cache-control") || "" };
}
const P = (who, extra = {}) => ({ id: who.id, token: who.token, ...extra });

async function setup(mode, digits = 4, count = 3) {
  const names = ["Ana", "Ben", "Cy", "Di"].slice(0, count);
  const a = await call("create", { body: { name: names[0], pin: "1111", mode, digits } });
  const players = [{ name: names[0], id: a.json.playerId, token: a.json.token }];
  for (const n of names.slice(1)) {
    const j = await call("join", { body: { code: a.json.code, name: n, pin: "1111" } });
    players.push({ name: n, id: j.json.playerId, token: j.json.token });
  }
  return { code: a.json.code, players, mode, digits };
}
const state = async (g, who) => (await call("state", { method: "GET", query: `?code=${g.code}`, ...(who ? P(who) : {}) })).json;
const has = (r, n) => new RegExp(`"${n}"|[:\\[,]${n}[,\\]}]`).test(r.text);

console.log("== new routes: identity, caching, bad input ==");
{
  const g = await setup("computer", 4, 3);
  const [a, b, c] = g.players;
  // a finished round to replay
  const st = await state(g, a);
  const cur = g.players.find((p) => p.id === st.currentPlayerId);
  await call("guess", { body: { code: g.code, guess: "1357" }, ...P(cur) });
  await call("endround", { body: { code: g.code }, ...P(a) }); // the organizer (creator) ends round 1

  const routes = [
    ["replay", { method: "GET", query: `?code=${g.code}&round=1` }],
    ["summary", { method: "GET", query: `?code=${g.code}` }],
    ["endgame", { body: { code: g.code } }],
  ];
  for (const [name, opts] of routes) {
    const cases = {
      "no headers": {},
      "empty token": { id: a.id, token: "" },
      "garbage token": { id: a.id, token: "z".repeat(64) },
      "another player's public id as the token": { id: a.id, token: b.id },
      "another player's real token": { id: a.id, token: b.token },
      "token in the query string only": { query: `${opts.query || ""}${opts.query ? "&" : "?"}token=${a.token}&id=${a.id}` },
      "token in the body only": { body: { code: g.code, id: a.id, token: a.token } },
    };
    for (const [label, extra] of Object.entries(cases)) {
      const r = await call(name, { ...opts, ...extra });
      check(r.status === 401, `${name}: ${label} -> 401 (got ${r.status})`);
      check(/no-store/.test(r.cache), `${name}: ${label} is no-store`);
      check(!r.text.includes(a.token) && !r.text.includes("1357"), `${name}: ${label} leaks nothing`);
    }
    const ok = await call(name, { ...opts, ...(name === "endgame" ? P(c) : P(a)) });
    check(/no-store/.test(ok.cache), `${name}: a good call is no-store`);
    check(!/stack|at \w+ \(|node_modules|UPSTASH/i.test(ok.text), `${name}: no internals in the reply`);
  }
  // Non-controls players can't end the game; the organizer can.
  check((await call("endgame", { body: { code: g.code }, ...P(b) })).status === 403, "endgame: a plain player -> 403");
  // Removed / away players: can read replays and the summary, can't end the game.
  await call("remove", { body: { code: g.code, targetPlayerId: c.id }, ...P(a) });
  await call("leave", { body: { code: g.code }, ...P(b) });
  for (const who of [c, b]) {
    check((await call("replay", { method: "GET", query: `?code=${g.code}&round=1`, ...P(who) })).status === 200, `${who.name}: replay readable`);
    check((await call("summary", { method: "GET", query: `?code=${g.code}`, ...P(who) })).status === 200, `${who.name}: summary readable`);
    check((await call("endgame", { body: { code: g.code }, ...P(who) })).status === 403, `${who.name}: endgame -> 403`);
  }
  // Bad input
  for (const raw of ["{not json", "", "[1,2]", "null", "42"]) {
    const r = await call("endgame", { raw, ...P(a) });
    check(r.status === 400 && r.json && r.json.error === "Invalid request.", `endgame: body ${JSON.stringify(raw)} -> clean 400 (got ${r.status})`);
  }
  for (const q of ["", "&round=", "&round=abc", "&round=1.5", "&round=-1", "&round=1e2", "&round=99999999", "&round=1%20OR%201"]) {
    const r = await call("replay", { method: "GET", query: `?code=${g.code}${q}`, ...P(a) });
    check([400, 404].includes(r.status) && r.json && r.json.error && !/stack/i.test(r.text), `replay${q}: clean 4xx (got ${r.status})`);
  }
  const nogame = await call("replay", { method: "GET", query: `?code=ZZZZZ&round=1`, ...P(a) });
  check(nogame.status === 404, "replay of a game that doesn't exist -> 404");
  check((await call("summary", { method: "GET", query: `?code=ZZZZZ`, ...P(a) })).status === 404, "summary of a game that doesn't exist -> 404");
}

console.log("== the live round's number never comes out of the replay route (any mode, any state) ==");
for (const mode of ["rotating", "computer", "duel"]) {
  const count = mode === "duel" ? 2 : 3;
  const g = await setup(mode, 4, count);
  const [a, b] = g.players;
  const secret = mode === "duel" ? { [a.id]: "1234", [b.id]: "5678" } : null;
  if (mode === "rotating") await call("pick", { body: { code: g.code, secret: "2468" }, ...P(a) });
  if (mode === "duel") { await call("pick", { body: { code: g.code, secret: secret[a.id] }, ...P(a) }); await call("pick", { body: { code: g.code, secret: secret[b.id] }, ...P(b) }); }
  const live = mode === "rotating" ? ["2468"] : mode === "duel" ? ["1234", "5678"] : [];
  const st = await state(g, a);
  const roundNow = st.round;
  const liveComputer = mode === "computer" ? [] : live;
  for (const who of g.players) {
    for (const n of [roundNow, roundNow + 1, 0, 999]) {
      const r = await call("replay", { method: "GET", query: `?code=${g.code}&round=${n}`, ...P(who) });
      check(r.status >= 400, `${mode}: live round ${n} for ${who.name} -> error (got ${r.status})`);
      for (const num of liveComputer) check(!has(r, num), `${mode}: the live number is not in the reply`);
    }
  }
  // The summary never carries it either.
  for (const who of g.players) {
    const r = await call("summary", { method: "GET", query: `?code=${g.code}`, ...P(who) });
    for (const num of liveComputer) check(!has(r, num), `${mode}: summary has no live number`);
  }
}

console.log("== duel over HTTP: full and rejoin, numbers only to their owner ==");
{
  const g = await setup("duel", 4, 2);
  const [a, b] = g.players;
  const third = await call("join", { body: { code: g.code, name: "Cy", pin: "1111" } });
  check(third.status === 403 && third.json.error === "This duel is full.", `a third person: "${third.json && third.json.error}" (${third.status})`);
  check((await call("rejoin", { body: { code: g.code, name: "Ben", pin: "1111" } })).status === 200, "the second player can rejoin with their PIN");
  check((await call("rejoin", { body: { code: g.code, name: "Cy", pin: "1111" } })).status >= 400, "a stranger cannot rejoin");
  const seen = [];
  const watch = async (label) => {
    for (const who of [a, b, null]) {
      const r = await call("state", { method: "GET", query: `?code=${g.code}`, ...(who ? P(who) : {}) });
      seen.push({ label, viewer: who ? who.name : "anon", r });
    }
  };
  await watch("start");
  const p1 = await call("pick", { body: { code: g.code, secret: "1234" }, ...P(a) });
  check(p1.status === 200 && !has(p1, "1234") || p1.status === 200, "pick ok");
  await watch("A picked");
  const p2 = await call("pick", { body: { code: g.code, secret: "5678" }, ...P(b) });
  check(p2.status === 200 && !has(p2, "1234") && !has(p2, "5678"), "B's pick response holds no numbers");
  await watch("both picked");
  const g1 = await call("guess", { body: { code: g.code, guess: "1357" }, ...P(a) });
  check(g1.status === 200 && !has(g1, "5678"), "a guess reply never contains the opponent's number");
  await watch("guess");
  const g2 = await call("guess", { body: { code: g.code, guess: "2468" }, ...P(b) });
  check(g2.status === 200 && !has(g2, "1234"), "B's guess reply never contains A's number");
  await watch("guess 2");
  for (const s of seen) {
    const mine = s.viewer === "Ana" ? "1234" : s.viewer === "Ben" ? "5678" : null;
    for (const n of ["1234", "5678"]) if (n !== mine) check(!has(s.r, n), `${s.label}: ${s.viewer} does not see ${n}`);
  }
  // Only the owner ever gets their own number
  const sa = await state(g, a);
  check(sa.duel.mySecret === "1234", "A sees their own number");
  check((await state(g, b)).duel.mySecret === "5678", "B sees their own number");
  check((await state(g)).duel.mySecret === null, "a stranger sees no number");
  // Attacks: a public id / other player's token / removed token on duel actions
  for (const route of ["guess", "pick", "endround", "newround", "endgame", "leave"]) {
    for (const [label, extra] of Object.entries({ "no token": { id: a.id }, "public id as token": { id: a.id, token: a.id }, "the other player's token": { id: a.id, token: b.token } })) {
      const r = await call(route, { body: { code: g.code, guess: "9876", secret: "9876" }, ...extra });
      check(r.status === 401, `duel ${route}: ${label} -> 401 (got ${r.status})`);
    }
  }
  await call("leave", { body: { code: g.code }, ...P(b) });
  for (const route of ["guess", "pick", "endround", "newround", "endgame"]) {
    const r = await call(route, { body: { code: g.code, guess: "9876", secret: "9876" }, ...P(b) });
    check(r.status === 403, `duel ${route}: an away player -> 403 (got ${r.status})`);
  }
  const wait = await call("guess", { body: { code: g.code, guess: "2468" }, ...P(a) });
  check(wait.status === 400 && /left the duel/.test(wait.json.error), `the other player sees "${wait.json && wait.json.error}"`);
  check((await call("comeback", { body: { code: g.code }, ...P(b) })).status === 200, "coming back works");
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => "- " + f).join("\n")); process.exit(1); }
