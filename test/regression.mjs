// Differential replay: the same seeded random games, run in lock-step against the
// ORIGINAL lib/game.js (from git HEAD, copied to test/.old/lib by the command below)
// and the current one, in rotating and computer modes. After every action it
// compares the results (errors, statuses, stars/dots, wins) and every player's
// view of the game (state), and at the end the stored data. The only differences
// allowed are the fields this update adds (player `color`, `gameOver`, times).
//
//   mkdir -p test/.old/lib && git show HEAD:lib/game.js > test/.old/lib/game.js \
//     && git show HEAD:lib/chatPresets.js > test/.old/lib/chatPresets.js
//   node test/regression.mjs [scenariosPerConfig] [steps]
import { createFakeUpstash } from "./fake-upstash.js";

const SCENARIOS = Number(process.argv[2] || 3);
const STEPS = Number(process.argv[3] || 260);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fakeOld = createFakeUpstash();
const fakeNew = createFakeUpstash();
const urlOld = await fakeOld.listen();
const urlNew = await fakeNew.listen();
process.env.UPSTASH_REDIS_REST_TOKEN = "t";
delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN;

const modOld = await import("./.old/lib/game.js");
const modNew = await import("../lib/game.js");

// Each version gets its own (identically seeded) stream for the app's own
// Math.random calls (game codes, computer-mode numbers).
let appRng = null;
Math.random = () => appRng();

const NAMES = ["Ana", "Boro", "Cleo", "Dax", "Eli", "Fen", "Gus", "Hana", "Ivo", "Jun"];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

let failures = 0;
let compared = 0;
function fail(msg) { failures++; if (failures <= 15) console.log("  DIFF:", msg); }

function makeVersion(label, mod, fake, url) {
  return { label, mod, fake, url, creds: new Map(), seed: 0, rng: null, code: null, idToName: new Map() };
}

// Runs `fn` as this version (its own env URL on first use, its own Math.random stream).
async function as(v, fn) {
  process.env.UPSTASH_REDIS_REST_URL = v.url;
  appRng = v.rng;
  return fn();
}

const who = (v, name) => (v.creds.has(name) ? { id: v.creds.get(name).id, token: v.creds.get(name).token } : { id: "nobody", token: "x" });

function norm(v, obj) {
  let s = JSON.stringify(obj);
  s = s.replace(UUID, (m) => v.idToName.get(m) || "<id>");
  const o = JSON.parse(s);
  const scrub = (x) => {
    if (Array.isArray(x)) return x.map(scrub);
    if (x && typeof x === "object") {
      const out = {};
      for (const [k, val] of Object.entries(x)) {
        if (k === "at" || k === "color" || k === "gameOver" || k === "tokenHashes" || k === "pinHash" || k === "pinSalt" || k === "joinedAt" || k === "createdAt") continue;
        out[k] = k === "solvedAt" ? !!val : scrub(val); // (wall-clock time: only "solved or not" is compared)
      }
      return out;
    }
    return x;
  };
  return scrub(o);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function rawRoom(v) { const e = v.fake.store.get(`room:${v.code}`); return e ? JSON.parse(e.value) : null; }
function rawPlayers(v) {
  const e = v.fake.store.get(`room:${v.code}:players`);
  return e ? [...e.value.values()].map((x) => JSON.parse(x)) : [];
}

async function scenario(mode, digits, size, seed) {
  const oldV = makeVersion("old", modOld, fakeOld, urlOld);
  const newV = makeVersion("new", modNew, fakeNew, urlNew);
  const versions = [oldV, newV];
  for (const v of versions) v.rng = mulberry32(seed * 7 + 1);
  const drv = mulberry32(seed * 13 + 5); // decisions, shared by both
  const tag = `${mode}/${digits}d/${size}p/seed${seed}`;
  let step = 0;

  const both = async (label, call) => {
    const outs = [];
    for (const v of versions) outs.push(await as(v, () => call(v)));
    const [a, b] = outs.map((o, i) => norm(versions[i], stripSecretsOfCreds(o)));
    compared++;
    if (!same(a, b)) fail(`${tag} step ${step} ${label}: old=${JSON.stringify(a)} new=${JSON.stringify(b)}`);
    return outs[0];
  };
  // Results of create/join/rejoin carry tokens/ids that differ by construction.
  const stripSecretsOfCreds = (o) => {
    if (o && typeof o === "object" && "token" in o) { const { token, playerId, ...rest } = o; return { ...rest, hasToken: !!token }; }
    return o;
  };

  // --- set-up
  const created = [];
  for (const v of versions) {
    const out = await as(v, () => v.mod.createRoom(NAMES[0], "1111", mode, digits));
    v.code = out.code; v.creds.set(NAMES[0], { id: out.playerId, token: out.token, pin: "1111" }); v.idToName.set(out.playerId, NAMES[0]);
    created.push(out);
  }
  let joined = 1;
  const joinLate = async (name) => {
    const outs = [];
    for (const v of versions) {
      const out = await as(v, () => v.mod.joinRoom(v.code, name, "1111"));
      if (out.playerId) { v.creds.set(name, { id: out.playerId, token: out.token, pin: "1111" }); v.idToName.set(out.playerId, name); }
      outs.push(norm(v, stripSecretsOfCreds(out)));
    }
    compared++;
    if (!same(outs[0], outs[1])) fail(`${tag} step ${step} join ${name}: ${JSON.stringify(outs)}`);
    if (!outs[0].error) joined++;
  };
  while (joined < size) await joinLate(NAMES[joined]);

  const members = () => [...oldV.creds.keys()];
  const pick = (arr) => arr[Math.floor(drv() * arr.length)];
  const randNum = () => {
    const pool = "0123456789".split(""); let s = "";
    while (s.length < digits) s += pool.splice(Math.floor(drv() * pool.length), 1)[0];
    return s[0] === "0" ? s.slice(1) + "0" : s;
  };
  const idOf = (name) => oldV.creds.get(name)?.id;
  const nameOfId = (id) => oldV.idToName.get(id);

  for (step = 1; step <= STEPS; step++) {
    const room = rawRoom(oldV);
    const roll = drv();
    const all = members();
    const turnHolder = (await as(oldV, () => modOld.getState(oldV.code, who(oldV, all[0])))).currentPlayerId;
    const curName = nameOfId(turnHolder);
    if (roll < 0.44) {
      const actor = drv() < 0.85 && curName ? curName : pick(all);
      const r = drv();
      const g = r < 0.16 && room.secret ? room.secret : r < 0.85 ? randNum() : r < 0.93 ? "12" : (rawPlayers(oldV).flatMap((p) => p.history)[0] || { guess: randNum() }).guess;
      await both(`guess ${actor} ${g}`, (v) => v.mod.submitGuess(v.code, who(v, actor), g));
    } else if (roll < 0.52) {
      const hostName = room.hostId ? nameOfId(room.hostId) : pick(all);
      const actor = drv() < 0.75 ? hostName : pick(all);
      const secret = drv() < 0.92 ? randNum() : "0123".slice(0, digits);
      await both(`pick ${actor}`, (v) => v.mod.pickSecret(v.code, who(v, actor), secret));
    } else if (roll < 0.58) {
      const holder = nameOfId(room.controlsId) || pick(all);
      const actor = drv() < 0.75 ? holder : pick(all);
      await both(`endRound ${actor}`, (v) => v.mod.endRound(v.code, who(v, actor)));
    } else if (roll < 0.67) {
      const actor = pick(all);
      await both(`newRound ${actor}`, (v) => v.mod.newRound(v.code, who(v, actor)));
    } else if (roll < 0.72) {
      const actor = pick(all);
      await both(`leave ${actor}`, (v) => v.mod.leaveGame(v.code, who(v, actor)));
    } else if (roll < 0.77) {
      const actor = pick(all);
      await both(`comeBack ${actor}`, (v) => v.mod.comeBack(v.code, who(v, actor)));
    } else if (roll < 0.81) {
      const actor = pick(all);
      const pin = drv() < 0.85 ? "1111" : "9999";
      const outs = [];
      for (const v of versions) {
        const out = await as(v, () => v.mod.rejoinRoom(v.code, actor, pin));
        if (out.token) v.creds.set(actor, { ...v.creds.get(actor), token: out.token });
        outs.push(norm(v, stripSecretsOfCreds(out)));
      }
      compared++;
      if (!same(outs[0], outs[1])) fail(`${tag} step ${step} rejoin ${actor}: ${JSON.stringify(outs)}`);
    } else if (roll < 0.85) {
      const holder = nameOfId(room.controlsId) || pick(all);
      const actor = drv() < 0.8 ? holder : pick(all);
      const target = pick(all);
      await both(`remove ${actor}->${target}`, (v) => v.mod.removePlayer(v.code, who(v, actor), v.creds.get(target).id));
    } else if (roll < 0.88) {
      const holder = nameOfId(room.controlsId) || pick(all);
      const target = pick(all);
      await both(`restore ${holder}->${target}`, (v) => v.mod.restorePlayer(v.code, who(v, holder), v.creds.get(target).id));
    } else if (roll < 0.92) {
      const holder = nameOfId(room.controlsId) || pick(all);
      await both(`skip ${holder}`, (v) => v.mod.skipTurn(v.code, who(v, holder)));
    } else if (roll < 0.95 && joined < NAMES.length) {
      await joinLate(NAMES[joined]);
    } else {
      const actor = pick(all);
      const text = drv() < 0.5 ? { text: `hi ${step}` } : { presetId: "nice-guess" };
      const outs = [];
      for (const v of versions) {
        const out = await as(v, () => v.mod.sendChatMessage(v.code, who(v, actor), text));
        outs.push(norm(v, out && out.message ? { ...out, message: { ...out.message, id: "m" } } : out));
      }
      compared++;
      if (!same(outs[0], outs[1])) fail(`${tag} step ${step} chat: ${JSON.stringify(outs)}`);
    }

    // Everyone's view, and a stranger's, must be identical.
    for (const viewer of [...members(), "__anon"]) {
      const sts = [];
      for (const v of versions) sts.push(norm(v, await as(v, () => v.mod.getState(v.code, viewer === "__anon" ? { id: "x", token: "y" } : who(v, viewer)))));
      compared++;
      if (!same(sts[0], sts[1])) {
        // find the first differing top-level key for a readable message
        const keys = Object.keys(sts[0]).filter((k) => !same(sts[0][k], sts[1][k]));
        fail(`${tag} step ${step} state for ${viewer}: differs in ${keys.join(",")}: old=${JSON.stringify(sts[0][keys[0]]).slice(0, 200)} new=${JSON.stringify(sts[1][keys[0]]).slice(0, 200)}`);
        break;
      }
    }
  }

  // The stored data matches too (apart from what this update adds).
  const snap = (v) => {
    const out = {};
    for (const [k, e] of v.fake.store) {
      if (!k.startsWith(`room:${v.code}`) || /:rounddetails$|:chatrate:|:back:|:pinfail:/.test(k)) continue;
      const key = k.replace(v.code, "CODE").replace(UUID, (m) => v.idToName.get(m) || "<id>");
      const parse = (x) => { try { return JSON.parse(x); } catch { return x; } };
      out[key] = e.value instanceof Map
        ? Object.fromEntries([...e.value].map(([f, x]) => [f.replace(UUID, (m) => v.idToName.get(m) || "<id>"), parse(x)]))
        : Array.isArray(e.value) ? e.value.map(parse) : parse(e.value);
    }
    const n = norm(v, out);
    return n;
  };
  const sa = snap(oldV), sb = snap(newV);
  const ka = Object.keys(sa).sort().join("|"), kb = Object.keys(sb).sort().join("|");
  compared++;
  if (ka !== kb) fail(`${tag} stored keys differ: old=${ka} new=${kb}`);
  for (const k of Object.keys(sa)) {
    if (!same(sa[k], sb[k])) {
      // player records: compare without the additions (color); room record exactly.
      fail(`${tag} stored ${k} differs: old=${JSON.stringify(sa[k]).slice(0, 300)} new=${JSON.stringify(sb[k]).slice(0, 300)}`);
    }
  }
  return rawRoom(oldV).round;
}

let totalRounds = 0;
for (const mode of ["rotating", "computer"]) {
  for (const digits of [3, 4, 5]) {
    for (const size of [2, 4, 6]) {
      for (let s = 1; s <= SCENARIOS; s++) {
        totalRounds += await scenario(mode, digits, size, s * 1000 + digits * 10 + size);
      }
    }
  }
}
await fakeOld.close(); await fakeNew.close();
console.log(`\nregression replay: ${compared} comparisons, ${failures} differences, ${totalRounds} rounds reached in total`);
process.exit(failures ? 1 : 0);
