export function makeT() {
  let passed = 0, failed = 0;
  const failures = [];
  let currentSuite = "";
  function suite(name) {
    currentSuite = name;
    console.log(`\n== ${name} ==`);
  }
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      failures.push({ suite: currentSuite, name, error: e });
      console.log(`  FAIL - ${name}`);
      console.log(`    ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n    ") : e}`);
    }
  }
  function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
  function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || "expected equal"}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
  function summary() {
    console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed})`);
    if (failures.length) {
      console.log("\nFailures:");
      for (const f of failures) console.log(`- [${f.suite}] ${f.name}: ${f.error.message}`);
    }
    return failed === 0;
  }
  return { suite, test, assert, eq, summary, get counts() { return { passed, failed }; } };
}

// Independent reference implementation of the star/dot rule (spec, not the
// lib's own code), so matrix tests catch real regressions rather than just
// checking the implementation agrees with itself.
export function refCheckGuess(secret, guess) {
  let stars = 0;
  for (let i = 0; i < secret.length; i++) if (secret[i] === guess[i]) stars++;
  let common = 0;
  for (const d of new Set(guess)) {
    const inSecret = secret.split(d).length - 1;
    const inGuess = guess.split(d).length - 1;
    common += Math.min(inSecret, inGuess);
  }
  return { stars, dots: common - stars };
}

export function randomValidNumber(digits, excludeSet = new Set()) {
  for (let attempt = 0; attempt < 5000; attempt++) {
    const pool = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const chosen = pool.slice(0, digits);
    if (chosen[0] === "0") {
      const idx = chosen.findIndex((d, i) => i > 0 && d !== "0");
      if (idx === -1) continue;
      [chosen[0], chosen[idx]] = [chosen[idx], chosen[0]];
    }
    const val = chosen.join("");
    if (!excludeSet.has(val)) return val;
  }
  throw new Error("Could not generate a fresh valid number");
}

export function rawRoom(fake, code) {
  const e = fake.store.get(`room:${code}`);
  if (!e) return null;
  return JSON.parse(e.value);
}
export function rawPlayer(fake, code, playerId) {
  const e = fake.store.get(`room:${code}:players`);
  if (!e) return null;
  const raw = e.value.get(playerId);
  return raw ? JSON.parse(raw) : null;
}
export function setRawPlayer(fake, code, playerId, patch) {
  const p = rawPlayer(fake, code, playerId);
  const next = { ...p, ...patch };
  const e = fake.store.get(`room:${code}:players`);
  e.value.set(playerId, JSON.stringify(next));
}
export function rawOrder(fake, code) {
  const e = fake.store.get(`room:${code}:order`);
  return e ? [...e.value] : [];
}

export async function createGameWithPlayers(game, { mode, digits, count, pin = "1111" }) {
  const names = ["Ana", "Boro", "Cleo", "Dax", "Eli", "Fen", "Gus", "Hana"].slice(0, count);
  const first = await game.createRoom(names[0], pin, mode, digits);
  if (first.error) throw new Error(`createRoom failed: ${first.error}`);
  const players = [{ id: first.playerId, name: names[0] }];
  for (let i = 1; i < count; i++) {
    const j = await game.joinRoom(first.code, names[i], pin);
    if (j.error) throw new Error(`joinRoom failed: ${j.error}`);
    players.push({ id: j.playerId, name: names[i] });
  }
  return { code: first.code, players };
}

export async function startRoundIfNeeded(game, fake, code) {
  const room = rawRoom(fake, code);
  if (room.mode === "rotating" && room.roundState === "pending") {
    const secret = randomValidNumber(room.digits);
    const out = await game.pickSecret(code, room.hostId, secret);
    if (out.error) throw new Error(`pickSecret failed: ${out.error}`);
  }
}

export async function advanceToNextRound(game, fake, code, anyPlayerId) {
  const room = rawRoom(fake, code);
  if (room.mode === "computer") {
    const out = await game.newRound(code, anyPlayerId);
    if (out.error) throw new Error(`newRound failed: ${out.error}`);
  }
  await startRoundIfNeeded(game, fake, code);
}

// Plays a round to completion: a couple of decoy guesses (to exercise turn
// rotation and star/dot correctness), then the actual secret to win.
export async function playRoundToWin(game, fake, code, viewerPlayerId, T) {
  await startRoundIfNeeded(game, fake, code);
  const room = rawRoom(fake, code);
  const secret = room.secret;
  const digits = room.digits;
  const used = new Set([secret]);
  const guesses = [];

  for (let i = 0; i < 2; i++) {
    const state = await game.getState(code, viewerPlayerId);
    const curId = state.currentPlayerId;
    if (!curId) break;
    const decoy = randomValidNumber(digits, used);
    used.add(decoy);
    const r = await game.submitGuess(code, curId, decoy);
    if (T) T.assert(!r.error, `decoy guess should succeed, got: ${r.error}`);
    if (T && r.result) {
      const ref = refCheckGuess(secret, decoy);
      T.eq(r.result.stars, ref.stars, `star count mismatch for decoy ${decoy} vs secret ${secret}`);
      T.eq(r.result.dots, ref.dots, `dot count mismatch for decoy ${decoy} vs secret ${secret}`);
    }
    guesses.push({ playerId: curId, guess: decoy, r });
  }

  const state2 = await game.getState(code, viewerPlayerId);
  const winnerId = state2.currentPlayerId;
  const r = await game.submitGuess(code, winnerId, secret);
  if (T) {
    T.assert(!r.error, `winning guess should succeed, got: ${r.error}`);
    T.assert(r.won === true, "winning guess should report won:true");
    T.eq(r.result.stars, digits, "winning guess should have full stars");
  }
  guesses.push({ playerId: winnerId, guess: secret, r });
  return { secret, digits, guesses, winnerId, roundJustWon: room.round };
}

export async function assertNoSecretLeak(T, game, fake, code, players) {
  const room = rawRoom(fake, code);
  for (const p of players) {
    const s = await game.getState(code, p.id);
    const json = JSON.stringify(s);
    T.assert(!/pinHash|pinSalt|nameLower|pinFails|pinLockUntil/i.test(json), `state leaked a private player field to ${p.name}`);
    if (room.mode === "computer") {
      T.eq(s.secret, null, `computer mode leaked the secret to ${p.name}`);
    } else if (room.mode === "rotating") {
      const shouldSee = s.isHost && s.roundState === "active";
      if (!shouldSee) T.eq(s.secret, null, `rotating mode leaked the secret to ${p.name} (isHost=${s.isHost}, roundState=${s.roundState})`);
    }
  }
  const anon = await game.getState(code, "not-a-real-player-id-00000000");
  T.eq(anon.secret, null, "an unjoined/anonymous viewer saw a secret");
}

// Tests talk to lib/game.js as real people would: with a public id AND a
// private token. This wrapper remembers the token that create/join/rejoin
// return for each id, and turns a plain id string into `{ id, token }` for
// every call that acts as a person — so test bodies can keep passing ids.
// Anything already shaped like `{ id, token }` (attack tests) passes through.
export function wrapGame(raw) {
  const tokens = new Map();
  const asActor = (v) => (v && typeof v === "object" ? v : { id: v, token: tokens.get(v) });
  const learn = (out) => { if (out && out.playerId && out.token) tokens.set(out.playerId, out.token); return out; };
  const actorAt = {
    getState: [1], pickSecret: [1], submitGuess: [1], skipTurn: [1], removePlayer: [1], restorePlayer: [1],
    endRound: [1], newRound: [1], leaveGame: [1], comeBack: [1], sendChatMessage: [1],
  };
  const wrapped = { ...raw, tokens, tokenOf: (id) => tokens.get(id) };
  for (const name of ["createRoom", "joinRoom", "rejoinRoom"]) wrapped[name] = async (...a) => learn(await raw[name](...a));
  for (const [name, idx] of Object.entries(actorAt)) {
    if (!raw[name]) continue;
    wrapped[name] = (...args) => {
      for (const i of idx) args[i] = asActor(args[i]);
      return raw[name](...args);
    };
  }
  return wrapped;
}

const ID_KEYS = new Set(["id", "playerId", "hostId", "controlsHolderId", "currentPlayerId", "code", "name", "hostName", "organizerName", "controlsHolderName", "winnerName"]);
// Where a finished round's number is allowed to be public.
const REVEAL_KEYS = new Set(["revealedSecret", "revealedRound", "rounds"]);

// Every string/number leaf of a response that could carry the live number.
// (Ids are random UUIDs and may contain digit runs by chance, so they're
// skipped; a number is only ever a guess/digit string or a plain integer.)
export function leaks(value, secret, path = "") {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return value.includes(secret) ? [`${path}=${value}`] : [];
  if (typeof value === "number") return value === Number(secret) ? [`${path}=${value}`] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => leaks(v, secret, `${path}[${i}]`));
  if (typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => (ID_KEYS.has(k) || REVEAL_KEYS.has(k) ? [] : leaks(v, secret, `${path}.${k}`)));
  }
  return [];
}

