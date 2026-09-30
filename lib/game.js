import { Redis } from "@upstash/redis";
import { findChatPreset } from "./chatPresets.js";


// Rooms (and everything scoped to them) disappear automatically after 24 hours.
const TTL = 60 * 60 * 24;

// Vercel integrations prefix these env var names differently depending on
// how the Upstash/KV store was connected (e.g. STORAGE_UPSTASH_REDIS_REST_URL).
// Find whichever key ends with the suffix we need, then look for its
// same-prefixed token counterpart. Server-only: nothing here is NEXT_PUBLIC_.
function findEnvPair(urlSuffix, tokenSuffix) {
  const urlKey = Object.keys(process.env).find((k) => k.endsWith(urlSuffix));
  if (!urlKey) return null;
  const prefix = urlKey.slice(0, urlKey.length - urlSuffix.length);
  const url = process.env[urlKey];
  const token = process.env[`${prefix}${tokenSuffix}`];
  if (!url || !token) return null;
  return { url, token };
}

let client;
function redis() {
  if (!client) {
    const creds =
      findEnvPair("UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN") ||
      findEnvPair("KV_REST_API_URL", "KV_REST_API_TOKEN");
    if (!creds) {
      throw new Error("Database not connected. Add an Upstash Redis (or Vercel KV) integration to this project.");
    }
    client = new Redis(creds);
  }
  return client;
}

const roomKey = (code) => `room:${code}`;
const playersKey = (code) => `room:${code}:players`;
const orderKey = (code) => `room:${code}:order`;
const turnKey = (code) => `room:${code}:turn`;
const namesKey = (code) => `room:${code}:names`;
const scoresKey = (code) => `room:${code}:scores`;
const turnClaimKey = (code, round, playerId, historyLen) => `room:${code}:turnclaim:${round}:${playerId}:${historyLen}`;
const winnerClaimKey = (code, round) => `room:${code}:winner:${round}`;
const roundStartClaimKey = (code, round) => `room:${code}:roundstart:${round}`;
const roundEndClaimKey = (code, round) => `room:${code}:roundend:${round}`;
const roundsKey = (code) => `room:${code}:rounds`;
const chatKey = (code) => `room:${code}:chat`;
const chatRateKey = (code, playerId) => `room:${code}:chatrate:${playerId}`;
const seqKey = (code) => `room:${code}:seq`;
const pinAttemptKey = (code, playerId) => `room:${code}:pinfail:${playerId}`;
const comebackClaimKey = (code, playerId, n) => `room:${code}:back:${playerId}:${n}`;

export const CHAT_MAX_LENGTH = 200; // characters in a free message
export const CHAT_KEEP = 100; // messages kept per room
export const CHAT_STATE_LIMIT = 50; // messages sent to the client on each poll
export const CHAT_RATE_LIMIT = 5; // messages per person...
export const CHAT_RATE_WINDOW = 10; // ...per this many seconds

const MAX_TOKENS = 8; // devices per person that can hold a live token at once
export const PIN_MAX_FAILS = 5; // wrong PINs allowed before a lockout...
export const PIN_LOCK_SECONDS = 5 * 60; // ...which lasts this long

export function cleanName(name) {
  return String(name || "").trim().slice(0, 20);
}

export function isValidDigits(digits) {
  return digits === 3 || digits === 4 || digits === 5;
}

// `digits` different digits, not starting with 0 (so it can't be typed/read
// as a shorter number).
export function isValidSecret(value, digits) {
  if (!isValidDigits(digits) || typeof value !== "string") return false;
  const re = new RegExp(`^[1-9]\\d{${digits - 1}}$`);
  return re.test(value) && new Set(value).size === digits;
}

export function isValidPin(pin) {
  return typeof pin === "string" && /^\d{4}$/.test(pin);
}

export function checkGuess(secret, guess) {
  const len = secret.length;
  let stars = 0;
  for (let i = 0; i < len; i++) if (secret[i] === guess[i]) stars++;
  let common = 0;
  for (const d of new Set(guess)) {
    const inSecret = secret.split(d).length - 1;
    const inGuess = guess.split(d).length - 1;
    common += Math.min(inSecret, inGuess);
  }
  return { stars, dots: common - stars };
}

function describePegs(stars, dots) {
  if (stars === 0 && dots === 0) return "no stars or dots";
  return `${"★".repeat(stars)}${"●".repeat(dots)}`;
}

function newCode() {
  // No look-alike characters (0/O, 1/I)
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// A random secret that follows the game's own rules for the room's digit
// count. Only one "0" exists in the digit pool, so if it lands in the
// leading position after a shuffle, swapping it with any other chosen digit
// (there's always at least one, since digits >= 3) fixes it.
function randomSecret(digits) {
  const pool = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const chosen = pool.slice(0, digits);
  if (chosen[0] === "0") {
    const idx = chosen.findIndex((d, i) => i > 0 && d !== "0");
    [chosen[0], chosen[idx]] = [chosen[idx], chosen[0]];
  }
  return chosen.join("");
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Hash a PIN with a salt. Pass an existing salt to verify a PIN against a
// stored hash; omit it to generate a fresh salted hash for a new player.
async function hashPin(pin, salt) {
  const useSalt = salt || randomSalt();
  const hash = await sha256Hex(`${useSalt}:${pin}`);
  return { hash, salt: useSalt };
}

// ---- Identity -----------------------------------------------------------
// A person proves who they are with a private random token (256 bits) handed
// out once, by create / join / rejoin. Only its SHA-256 hash is stored, inside
// that person's own player record — which every request already loads — so
// checking a token never costs an extra database command. The public player
// id is for display and for choosing targets only; it is never proof of
// identity.
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const hashToken = (token) => sha256Hex(`token:${token}`);

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyToken(player, token) {
  if (!player || typeof token !== "string" || token.length < 32 || token.length > 256) return false;
  const stored = Array.isArray(player.tokenHashes) ? player.tokenHashes : [];
  if (!stored.length) return false;
  const h = await hashToken(token);
  let ok = false;
  for (const s of stored) if (safeEqual(s, h)) ok = true;
  return ok;
}

// Adds a fresh token to the player record (in memory — the caller saves it).
async function issueToken(player) {
  const token = randomToken();
  const hashes = Array.isArray(player.tokenHashes) ? player.tokenHashes : [];
  player.tokenHashes = [...hashes, await hashToken(token)].slice(-MAX_TOKENS);
  return token;
}

const NOT_SIGNED_IN = { error: "Please sign in again.", status: 401 };

// The person making a request: their record, if (and only if) the token
// matches. One HGET — the same one every action already did.
async function loadActor(code, who) {
  if (!who || typeof who.id !== "string" || !who.id) return null;
  const player = await redis().hget(playersKey(code), who.id);
  return (await verifyToken(player, who.token)) ? player : null;
}

// Someone who's away or removed can read the game, but not act in it.
function inactiveError(player) {
  if (player.leaveReason === "left") return { error: "You left this game. Tap Rejoin to come back.", status: 403 };
  return { error: "You've been removed from this game.", status: 403 };
}

const isAway = (p) => !!p.removed && p.leaveReason === "left";

const uniq = (list) => Array.from(new Set(list));

// Rooms created before this rewrite are missing `mode`/`digits`/`creatorId`.
// Rather than risk crashing on their old shape, every reader treats them as
// if the game didn't exist.
export async function getRoom(code) {
  const room = await redis().get(roomKey(code));
  if (!room || !room.mode || !room.digits || !room.creatorId) return null;
  return room;
}

async function getPlayers(code) {
  const all = (await redis().hgetall(playersKey(code))) || {};
  return Object.values(all);
}

// ---- Hosting rotation ---------------------------------------------------
// Everyone who ever joined, in the order they first joined. Restored players
// and people who came back keep their original place here (it never changes),
// and late joiners land at the end. `joinSeq` is a per-room counter; rooms
// from before it existed fall back to the join time.
function joinOrder(players) {
  const seq = (p) => (typeof p.joinSeq === "number" ? p.joinSeq : -1);
  return [...players].sort((a, b) => seq(a) - seq(b) || a.joinedAt - b.joinedAt);
}

// Hosting goes around in join order: the next active player (not removed,
// not away) after `anchorId`, wrapping to the start of the list. `anchorId`
// is the host of the round that just ended — or, if that host left mid-round,
// the departed host, whose place in the order is still the starting point
// (they're skipped while they're away). The anchor itself is the last
// candidate, so a lone player just hosts again.
export function nextHostAfter(players, anchorId) {
  const ordered = joinOrder(players);
  if (!ordered.length) return null;
  const start = ordered.findIndex((p) => p.id === anchorId);
  for (let i = 1; i <= ordered.length; i++) {
    const p = ordered[(start + i) % ordered.length];
    if (!p.removed) return p.id;
  }
  return null;
}

// Moves a rotating room on to its next round: the next host per the rotation
// rule above (they also pick up host controls), waiting for their number.
function rotateToNextRound(room, players) {
  const next = nextHostAfter(players, room.hostId || room.hostAnchor || null);
  room.round += 1;
  room.hostId = next;
  room.controlsId = next;
  if (next) room.hostAnchor = next;
  room.roundState = "pending";
  room.secret = null;
}

// The turn order for a round: everyone in join order, except in rotating
// mode where the current host never guesses and so is never in it.
function turnOrderFor(room, order) {
  if (room.mode === "rotating" && room.hostId) {
    return order.filter((id) => id !== room.hostId);
  }
  return order;
}

// The single source of truth for whose turn it is right now. Used by every
// path that reads or changes the turn (getState, submitGuess, skipTurn,
// removePlayer, leaveGame, newRound) so the screen and the server can never
// disagree. Self-repairing: if the stored turn is empty, missing, or points
// at someone who isn't eligible right now (removed, away, the current host,
// or otherwise not in the live turn order), the correct value is computed
// fresh from the live order and immediately written back — so the fix is
// visible to every reader from that point on, not just this call.
async function resolveTurn(code, room) {
  const r = redis();
  const order = uniq(await r.lrange(orderKey(code), 0, -1));
  const turnOrder = turnOrderFor(room, order);
  if (!turnOrder.length) {
    await r.del(turnKey(code));
    return { order, turnOrder, currentPlayerId: null };
  }
  const stored = await r.get(turnKey(code));
  const currentPlayerId = stored && turnOrder.includes(stored) ? stored : turnOrder[0];
  if (currentPlayerId !== stored) await r.set(turnKey(code), currentPlayerId, { ex: TTL });
  return { order, turnOrder, currentPlayerId };
}

// Advances the turn from `fromPlayerId` to whoever is next in the live turn
// order, and persists it. The one place that decides "whose turn is next".
async function advanceTurn(code, room, fromPlayerId) {
  const r = redis();
  const { turnOrder } = await resolveTurn(code, room);
  if (!turnOrder.length) {
    await r.del(turnKey(code));
    return null;
  }
  const idx = turnOrder.indexOf(fromPlayerId);
  const nextPlayerId = turnOrder[(idx === -1 ? 0 : idx + 1) % turnOrder.length];
  await r.set(turnKey(code), nextPlayerId, { ex: TTL });
  return nextPlayerId;
}

// After someone leaves the turn order (removed, or left on their own): if it
// was their turn, it passes to whoever slides into their slot — the next
// player — immediately; otherwise nobody's turn changes.
async function settleTurnAfterDeparture(code, room, before, newOrder) {
  const r = redis();
  const newTurnOrder = turnOrderFor(room, newOrder);
  if (!newTurnOrder.length) {
    await r.del(turnKey(code));
    return;
  }
  let nextTurn = before.currentPlayerId;
  if (!newTurnOrder.includes(nextTurn)) {
    const oldIdx = before.turnOrder.indexOf(before.currentPlayerId);
    nextTurn = newTurnOrder[(oldIdx === -1 ? 0 : oldIdx) % newTurnOrder.length];
  }
  await r.set(turnKey(code), nextTurn, { ex: TTL });
}

async function resetHistories(code) {
  const r = redis();
  const players = await getPlayers(code);
  if (!players.length) return;
  const reset = {};
  for (const p of players) reset[p.id] = { ...p, history: [], solvedAt: null };
  await r.hset(playersKey(code), reset);
}

async function bumpScore(code, playerId, tries) {
  const r = redis();
  const cur = (await r.hget(scoresKey(code), playerId)) || { wins: 0, triesSum: 0 };
  const next = { wins: cur.wins + 1, triesSum: cur.triesSum + tries };
  await r.hset(scoresKey(code), { [playerId]: next });
  await r.expire(scoresKey(code), TTL);
}

// Saves a finished round's result (winner, number, total guesses by
// everyone) before the next round clears the guess histories. Only ever
// called once the round is over, so the rounds table holds finished rounds
// only.
async function recordRound(code, room, winner, totalTries) {
  const r = redis();
  await r.rpush(roundsKey(code), {
    round: room.round,
    secret: room.secret,
    winnerName: winner ? winner.name : null,
    totalTries,
  });
  await r.expire(roundsKey(code), TTL);
}

async function buildScoreboard(code, allPlayers) {
  const raw = (await redis().hgetall(scoresKey(code))) || {};
  const entries = allPlayers.map((p) => {
    const s = raw[p.id] || { wins: 0, triesSum: 0 };
    const avgTries = s.wins > 0 ? s.triesSum / s.wins : null;
    return { id: p.id, name: p.name, removed: !!p.removed, leaveReason: p.leaveReason || null, wins: s.wins, avgTries };
  });
  entries.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (a.wins === 0) return 0;
    return (a.avgTries ?? Infinity) - (b.avgTries ?? Infinity);
  });
  let rank = 0;
  let prevKey = null;
  entries.forEach((e, i) => {
    if (e.wins === 0) { e.rank = null; return; }
    const key = `${e.wins}:${e.avgTries}`;
    if (key !== prevKey) { rank = i + 1; prevKey = key; }
    e.rank = rank;
  });
  return entries;
}

function newPlayer({ id, name, pinHash, pinSalt, tokenHash, joinSeq, now }) {
  return {
    id,
    name,
    nameLower: name.toLowerCase(),
    pinHash,
    pinSalt,
    tokenHashes: [tokenHash],
    history: [],
    solvedAt: null,
    joinedAt: now,
    joinSeq,
    removed: false,
    leaveReason: null, // null | "removed" | "left"
    leaveCount: 0,
  };
}

// The next place in the join order (atomic, so two people joining at the same
// instant still get different places).
async function nextJoinSeq(code) {
  const r = redis();
  const [seq] = await r.pipeline().incr(seqKey(code)).expire(seqKey(code), TTL).exec();
  return seq;
}

// The single source of truth for who currently holds host/organizer
// controls (skip turn, remove player, end round, leave game). `order`
// (the join-order list) only ever contains active, non-removed players —
// every removal/leave path lrem's it immediately — so "is this id still in
// `order`" is exactly "is this id still eligible to hold controls".
// Self-repairing: if the recorded holder is gone, the next player in join
// order picks it up and that repair is persisted immediately, so every
// caller (and the next poll) sees the same, already-fixed value.
async function resolveControls(code, room) {
  const r = redis();
  const order = uniq(await r.lrange(orderKey(code), 0, -1));
  if (room.controlsId && order.includes(room.controlsId)) return room.controlsId;
  const next = order[0] || null;
  if (next !== room.controlsId) {
    room.controlsId = next;
    await r.set(roomKey(code), room, { ex: TTL });
  }
  return next;
}

export async function createRoom(name, pin, mode, digits) {
  const hostName = cleanName(name);
  if (!hostName) return { error: "Enter your name." };
  if (!isValidPin(pin)) return { error: "Pick a 4-digit PIN." };
  if (mode !== "rotating" && mode !== "computer") return { error: "Choose a game mode." };
  if (!isValidDigits(digits)) return { error: "Choose 3, 4, or 5 digits." };

  const r = redis();
  const creatorId = crypto.randomUUID();
  const { hash, salt } = await hashPin(pin);
  const token = randomToken();
  const tokenHash = await hashToken(token);
  const now = Date.now();

  for (let i = 0; i < 5; i++) {
    const code = newCode();
    const secret = mode === "computer" ? randomSecret(digits) : null;
    const room = {
      code,
      mode,
      digits,
      creatorId,
      round: 1,
      hostId: mode === "rotating" ? creatorId : null,
      // Where the hosting rotation continues from: the most recent host.
      // Unlike `hostId` it survives the host leaving mid-round.
      hostAnchor: mode === "rotating" ? creatorId : null,
      // Whoever currently holds host/organizer controls (skip turn, remove
      // player, end round, leave game) — starts out as the creator, but
      // moves independently of `hostId` once a rotating host leaves mid-
      // round (the round goes hostless, but someone still needs controls).
      controlsId: creatorId,
      roundState: mode === "rotating" ? "pending" : "active",
      secret,
      winner: null,
      revealedSecret: null,
      revealedRound: null,
      createdAt: now,
    };
    // NX makes the check-and-create atomic: if this code is somehow already
    // taken (a prior room, or a concurrent create() landing on the same
    // random code), this fails instead of silently overwriting it, and we
    // just try again with a fresh code.
    const created = await r.set(roomKey(code), room, { nx: true, ex: TTL });
    if (!created) continue;

    const joinSeq = await nextJoinSeq(code);
    const player = newPlayer({ id: creatorId, name: hostName, pinHash: hash, pinSalt: salt, tokenHash, joinSeq, now });
    await r.hset(playersKey(code), { [creatorId]: player });
    await r.expire(playersKey(code), TTL);
    await r.rpush(orderKey(code), creatorId);
    await r.expire(orderKey(code), TTL);
    await r.hsetnx(namesKey(code), hostName.toLowerCase(), creatorId);
    await r.expire(namesKey(code), TTL);
    if (mode === "computer") {
      await r.set(turnKey(code), creatorId, { ex: TTL });
    }
    return { code, playerId: creatorId, token };
  }
  throw new Error("Couldn't generate a unique game code. Please try again.");
}

// When nobody was left holding controls (everyone left), the first person to
// join or come back picks them up — and, in rotating mode with a round
// waiting for a number, becomes the host who picks it. `alone` is true when
// they're the only active person in the game right now.
function claimEmptySeats(room, playerId, alone) {
  let changed = false;
  if (!room.controlsId || alone) {
    room.controlsId = playerId;
    changed = true;
  }
  if (room.mode === "rotating" && room.roundState === "pending" && (!room.hostId || alone)) {
    room.hostId = playerId;
    room.hostAnchor = playerId;
    room.controlsId = playerId;
    changed = true;
  }
  return changed;
}

export async function joinRoom(code, name, pin) {
  const playerName = cleanName(name);
  if (!playerName) return { error: "Enter your name." };
  if (!isValidPin(pin)) return { error: "Pick a 4-digit PIN." };

  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "No game found with that code.", status: 404 };

  const nameLower = playerName.toLowerCase();
  const playerId = crypto.randomUUID();
  const claimed = await r.hsetnx(namesKey(code), nameLower, playerId);
  await r.expire(namesKey(code), TTL);
  if (!claimed) return { error: "That name is already taken in this game." };

  const { hash, salt } = await hashPin(pin);
  const token = randomToken();
  const tokenHash = await hashToken(token);
  const now = Date.now();
  const joinSeq = await nextJoinSeq(code);
  const player = newPlayer({ id: playerId, name: playerName, pinHash: hash, pinSalt: salt, tokenHash, joinSeq, now });
  await r.hset(playersKey(code), { [playerId]: player });
  await r.expire(playersKey(code), TTL);
  const count = await r.rpush(orderKey(code), playerId);
  await r.expire(orderKey(code), TTL);

  // A late joiner is added at the end of the turn order (and of the hosting
  // rotation) automatically. But if the game had nobody left holding
  // controls, this joiner picks them up.
  if (claimEmptySeats(room, playerId, count === 1)) await r.set(roomKey(code), room, { ex: TTL });

  return { playerId, token };
}

// Brings an away player back as a normal player: at the end of the turn
// order (never twice), score and this round's guesses kept, and never
// automatically host or organizer — except when they're the only one here.
// Saves the (already updated) player record.
async function reactivate(code, room, player) {
  const r = redis();
  // Two taps at once (or a Rejoin and a PIN rejoin) must only come back once.
  const claimed = await r.set(comebackClaimKey(code, player.id, player.leaveCount || 0), "1", { nx: true, ex: 60 });
  if (!claimed) return;

  player.removed = false;
  player.leaveReason = null;
  await r.hset(playersKey(code), { [player.id]: player });
  await r.expire(playersKey(code), TTL);

  await r.lrem(orderKey(code), 0, player.id);
  const count = await r.rpush(orderKey(code), player.id);
  await r.expire(orderKey(code), TTL);
  if (claimEmptySeats(room, player.id, count === 1)) await r.set(roomKey(code), room, { ex: TTL });
}

export async function rejoinRoom(code, name, pin) {
  const playerName = cleanName(name);
  if (!playerName) return { error: "Enter your name." };
  if (!isValidPin(pin)) return { error: "Enter your 4-digit PIN." };

  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "No game found with that code.", status: 404 };

  const nameLower = playerName.toLowerCase();
  const playerId = await r.hget(namesKey(code), nameLower);
  if (!playerId) return { error: "No player with that name in this game." };
  const player = await r.hget(playersKey(code), playerId);
  if (!player) return { error: "No player with that name in this game." };
  if (player.removed && !isAway(player)) return { error: "That player was removed and can't rejoin." };

  // Count this attempt first, atomically, so a burst of parallel requests
  // can't all be checked before any of them is counted: at most
  // PIN_MAX_FAILS PINs are ever tried per lockout window.
  const ak = pinAttemptKey(code, playerId);
  const [tries] = await r.pipeline().incr(ak).expire(ak, PIN_LOCK_SECONDS, "NX").exec();
  if (tries > PIN_MAX_FAILS) {
    const secs = await r.ttl(ak);
    const mins = Math.max(1, Math.ceil((secs > 0 ? secs : PIN_LOCK_SECONDS) / 60));
    return { error: `Too many attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`, status: 429 };
  }

  const { hash } = await hashPin(pin, player.pinSalt);
  if (!safeEqual(hash, player.pinHash)) {
    if (tries === PIN_MAX_FAILS) {
      await r.expire(ak, PIN_LOCK_SECONDS); // the lock runs from the last wrong try
      return { error: "Too many attempts. Try again in 5 minutes.", status: 429 };
    }
    const left = PIN_MAX_FAILS - tries;
    return { error: `Wrong PIN. ${left} attempt${left === 1 ? "" : "s"} left.` };
  }

  await r.del(ak);
  const token = await issueToken(player);
  await r.hset(playersKey(code), { [playerId]: player });
  await r.expire(playersKey(code), TTL);
  if (isAway(player)) await reactivate(code, room, player);
  return { playerId, token };
}

// Someone who left comes back on the same device, proving who they are with
// their token — no PIN. Players removed by the host can't (they need Restore).
export async function comeBack(code, who) {
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists.", status: 404 };
  const player = await loadActor(code, who);
  if (!player) return NOT_SIGNED_IN;
  if (!player.removed) return { ok: true }; // already back
  if (!isAway(player)) return { error: "The host removed you — ask them to restore you.", status: 403 };
  await reactivate(code, room, player);
  return { ok: true };
}

// Rotating mode only: the current host picks the secret and starts the round.
export async function pickSecret(code, who, secret) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };
  const player = await loadActor(code, who);
  if (!player) return NOT_SIGNED_IN;
  if (player.removed) return inactiveError(player);
  if (room.mode !== "rotating") return { error: "This game picks its own numbers." };
  if (room.roundState !== "pending") return { error: "The number for this round is already set." };
  if (room.hostId !== player.id) return { error: "Only the current host can pick the number.", status: 403 };
  if (!isValidSecret(secret, room.digits)) {
    return { error: `The number must use ${room.digits} different digits, not starting with 0.` };
  }

  room.secret = secret;
  room.roundState = "active";
  room.revealedSecret = null;
  room.revealedRound = null;
  await r.set(roomKey(code), room, { ex: TTL });
  // The new round starts now — clear out the previous round's guesses.
  await resetHistories(code);
  await r.del(turnKey(code));
  await resolveTurn(code, room);

  return { ok: true };
}

export async function submitGuess(code, who, guess) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };
  const player = await loadActor(code, who);
  if (!player) return NOT_SIGNED_IN;
  if (player.removed) return inactiveError(player);
  const playerId = player.id;
  if (!isValidSecret(guess, room.digits)) {
    return { error: `A guess must use ${room.digits} different digits, not starting with 0.` };
  }
  if (room.roundState === "pending") return { error: "Waiting for the host to pick a number." };
  if (room.roundState === "ended") return { error: "The round is over." };
  if (room.mode === "rotating" && room.hostId === playerId) return { error: "The host doesn't guess this round." };

  const { currentPlayerId } = await resolveTurn(code, room);
  if (currentPlayerId !== playerId) return { error: "It's not your turn." };

  // Duplicate guess protection: check everyone's guesses so far this round
  // (their `history` is wiped at the start of each round) before this one
  // is allowed to use up the player's turn.
  const allPlayers = await getPlayers(code);
  for (const p of allPlayers) {
    const prior = p.history.find((h) => h.guess === guess);
    if (prior) {
      const tried = p.id === playerId ? "You" : p.name;
      return { error: `${tried} already tried this: ${describePegs(prior.stars, prior.dots)}` };
    }
  }

  // Guard against a double-tap (or any concurrent duplicate request) firing
  // two guesses for the same turn: this player's own guess count (read just
  // above, before this guess is added) is a deterministic stand-in for
  // "which turn of theirs this is" — two concurrent requests for the same
  // turn compute the same claim key, and only the first SET NX wins. Scoped
  // by round, since history is cleared on every new round.
  const claimed = await r.set(turnClaimKey(code, room.round, playerId, player.history.length), "1", { nx: true, ex: TTL });
  if (!claimed) return { error: "It's not your turn." };

  const result = checkGuess(room.secret, guess);
  player.history.push({ guess, ...result, at: Date.now() });
  const won = result.stars === room.digits;
  if (won) player.solvedAt = Date.now();
  await r.hset(playersKey(code), { [playerId]: player });
  await r.expire(playersKey(code), TTL);

  if (won) {
    const wonClaim = await r.set(winnerClaimKey(code, room.round), playerId, { nx: true, ex: TTL });
    if (wonClaim) {
      await bumpScore(code, playerId, player.history.length);
      room.winner = { id: playerId, name: player.name, tries: player.history.length };
      room.revealedSecret = room.secret;
      room.revealedRound = room.round;
      room.roundState = "ended";
      const totalTries = allPlayers.reduce((sum, p) => sum + (p.id === playerId ? player.history.length : p.history.length), 0);
      await recordRound(code, room, room.winner, totalTries);

      if (room.mode === "rotating") {
        // Hosting rotates on in join order — winning has no effect on who
        // hosts next. The next round starts out pending until that host
        // picks a number. Guess histories stay put (so the winning guess
        // stays visible) until pickSecret() actually starts the new round.
        rotateToNextRound(room, allPlayers);
        await r.del(turnKey(code));
      }

      await r.set(roomKey(code), room, { ex: TTL });
      return { result, won: true };
    }
    // Someone else's concurrent guess already claimed the win first (only
    // possible if two players happen to submit the exact secret at once).
    // Fall through and just advance the turn normally.
  }

  await advanceTurn(code, room, playerId);
  return { result };
}

// Skip the current turn. Whoever currently holds host/organizer controls,
// checked on the server — resolveControls() self-heals if that's changed
// (e.g. the host left) since the requester last polled.
export async function skipTurn(code, who) {
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };
  const requester = await loadActor(code, who);
  if (!requester) return NOT_SIGNED_IN;
  if (requester.removed) return inactiveError(requester);
  if (room.roundState !== "active") return { error: "There's no active turn to skip right now." };

  const controlsId = await resolveControls(code, room);
  if (controlsId !== requester.id) {
    return { error: room.mode === "rotating" ? "Only the host can skip a turn." : "Only the organizer can skip a turn.", status: 403 };
  }

  const { turnOrder, currentPlayerId } = await resolveTurn(code, room);
  if (!turnOrder.length || !currentPlayerId) return { error: "No players to skip to yet." };

  await advanceTurn(code, room, currentPlayerId);
  return { ok: true };
}

// Only the current host/organizer can remove a player — never themselves
// (that's what "Leave game" is for), and never the host/organizer seat
// itself, which can only ever change hands via leaveGame() or by the round
// ending.
export async function removePlayer(code, who, targetPlayerId) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };
  const requester = await loadActor(code, who);
  if (!requester) return NOT_SIGNED_IN;
  if (requester.removed) return inactiveError(requester);
  const requesterId = requester.id;
  if (requesterId === targetPlayerId) return { error: "You can't remove yourself — use \"Leave game\" instead." };

  const controlsId = await resolveControls(code, room);
  if (controlsId !== requesterId) {
    return { error: room.mode === "rotating" ? "Only the host can remove a player." : "Only the organizer can remove a player.", status: 403 };
  }
  if (room.mode === "rotating" && room.hostId === targetPlayerId) {
    return { error: "The host can't be removed — use \"Leave game\" instead." };
  }
  if (controlsId === targetPlayerId) {
    return {
      error: room.mode === "rotating"
        ? "The host can't be removed — use \"Leave game\" instead."
        : "The organizer can't be removed — use \"Leave game\" instead.",
    };
  }

  const order = uniq(await r.lrange(orderKey(code), 0, -1));
  if (!order.includes(targetPlayerId)) return { error: "That player isn't in this game." };

  const before = await resolveTurn(code, room);

  const player = await r.hget(playersKey(code), targetPlayerId);
  if (player) {
    player.removed = true;
    player.leaveReason = "removed";
    await r.hset(playersKey(code), { [targetPlayerId]: player });
    await r.expire(playersKey(code), TTL);
  }
  await r.lrem(orderKey(code), 0, targetPlayerId);

  // The host/organizer seat can't be the target (rejected above), so
  // `room.hostId`/`room.controlsId` never need to change here — only the
  // turn order can shrink.
  await settleTurnAfterDeparture(code, room, before, order.filter((id) => id !== targetPlayerId));

  return { ok: true };
}


// The current host/organizer brings back a player they removed. Only works
// for players who were removed, not for someone who left on their own (they
// come back by themselves). The restored player keeps their name, PIN,
// history, score and place in the hosting order, and is added at the end of
// the turn order.
export async function restorePlayer(code, who, targetPlayerId) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };
  const requester = await loadActor(code, who);
  if (!requester) return NOT_SIGNED_IN;
  if (requester.removed) return inactiveError(requester);

  const controlsId = await resolveControls(code, room);
  if (controlsId !== requester.id) {
    return { error: room.mode === "rotating" ? "Only the host can restore a player." : "Only the organizer can restore a player.", status: 403 };
  }

  const player = await r.hget(playersKey(code), targetPlayerId);
  if (!player) return { error: "That player isn't in this game." };
  if (!player.removed) return { error: "That player is already in the game." };
  if (player.leaveReason !== "removed") return { error: "That player left on their own and can come back themselves." };

  player.removed = false;
  player.leaveReason = null;
  await r.hset(playersKey(code), { [targetPlayerId]: player });
  await r.expire(playersKey(code), TTL);
  await r.del(pinAttemptKey(code, targetPlayerId));

  // Back at the end of the turn order (removing first makes sure they're
  // never in the list twice).
  await r.lrem(orderKey(code), 0, targetPlayerId);
  await r.rpush(orderKey(code), targetPlayerId);
  await r.expire(orderKey(code), TTL);

  // Keep whoever's turn it is now exactly as it is.
  await resolveTurn(code, room);
  return { ok: true };
}

// The current host (rotating) or organizer (computer) ends the round with
// no winner. The secret is revealed to everyone, and nobody scores.
export async function endRound(code, who) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };
  const requester = await loadActor(code, who);
  if (!requester) return NOT_SIGNED_IN;
  if (requester.removed) return inactiveError(requester);
  if (room.roundState !== "active") return { error: "There's no active round to end." };

  const controlsId = await resolveControls(code, room);
  if (controlsId !== requester.id) {
    return { error: room.mode === "rotating" ? "Only the host can end the round." : "Only the organizer can end the round.", status: 403 };
  }

  // Guard against two concurrent "End round" requests (e.g. a double-tap)
  // both reading the round as still active before either writes it back as
  // ended, which would otherwise record the same round twice.
  const claimed = await r.set(roundEndClaimKey(code, room.round), requester.id, { nx: true, ex: TTL });
  if (!claimed) return { ok: true };

  const players = await getPlayers(code);
  room.winner = null;
  room.revealedSecret = room.secret;
  room.revealedRound = room.round;
  room.roundState = "ended";
  await recordRound(code, room, null, players.reduce((sum, p) => sum + p.history.length, 0));

  if (room.mode === "rotating") {
    // Hosting rotates on in join order, same as when somebody wins — and
    // after a hostless round it carries on from the departed host's place.
    // Guess histories stay put until pickSecret() starts the new round.
    rotateToNextRound(room, players);
    await r.del(turnKey(code));
  }

  await r.set(roomKey(code), room, { ex: TTL });
  return { ok: true };
}

// Computer mode only: any active player starts the next round once the
// current one has ended. `roundStartClaimKey` makes sure two people
// pressing "Next round" at once only starts one round.
export async function newRound(code, who) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };
  const player = await loadActor(code, who);
  if (!player) return NOT_SIGNED_IN;
  if (player.removed) return inactiveError(player);
  if (room.mode !== "computer") return { error: "This mode starts rounds automatically." };
  if (room.roundState !== "ended") return { error: "The current round hasn't ended yet." };

  const nextRound = room.round + 1;
  const claimed = await r.set(roundStartClaimKey(code, nextRound), "1", { nx: true, ex: TTL });
  if (!claimed) return { ok: true };

  room.round = nextRound;
  room.secret = randomSecret(room.digits);
  room.winner = null;
  room.roundState = "active";
  room.revealedSecret = null;
  room.revealedRound = null;
  await r.set(roomKey(code), room, { ex: TTL });
  await resetHistories(code);
  await r.del(turnKey(code));
  await resolveTurn(code, room);

  return { ok: true };
}

// Anyone in the game can leave, and come back any time (see comeBack and
// rejoinRoom). Leaving takes you out of the turn order — if it was your turn,
// it passes to the next player at once — while your guesses stay visible
// (marked "away") and your score is kept.
//
// If the leaver held a seat:
// Rotating mode, the host:
//  - mid-round: the round goes hostless. The secret stays exactly as it
//    was, hidden from everyone (nobody picks it up), and everyone else
//    keeps their turn and history. The next player in join order picks up
//    host/organizer controls (skip/remove/end round) but does NOT become
//    host — they keep playing and guessing normally. The next round's host
//    is chosen from the departed host's place in the rotation.
//  - between rounds (pending, waiting for a number): the next active player
//    after them in the hosting rotation becomes host immediately.
// Whoever holds controls (the hostless round's stand-in, or the computer
// mode organizer): controls pass to the next player in join order.
// If that was the last active person, the game stays open; the first person
// to join or come back picks the seats up.
export async function leaveGame(code, who) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };
  const player = await loadActor(code, who);
  if (!player) return NOT_SIGNED_IN;
  if (player.removed) return inactiveError(player);
  const playerId = player.id;

  const players = await getPlayers(code);
  const before = await resolveTurn(code, room);
  const wasHost = room.mode === "rotating" && room.hostId === playerId;
  const wasControls = room.controlsId === playerId;

  player.removed = true;
  player.leaveReason = "left";
  player.leaveCount = (player.leaveCount || 0) + 1;
  await r.hset(playersKey(code), { [playerId]: player });
  await r.expire(playersKey(code), TTL);
  await r.lrem(orderKey(code), 0, playerId);

  const newOrder = before.order.filter((id) => id !== playerId);
  if (wasControls || wasHost) room.controlsId = newOrder[0] || null;
  if (wasHost) {
    if (room.roundState === "pending") {
      // Between rounds the next host must be in place right away so they can
      // pick a number. Mid-round, the round simply goes hostless — the
      // secret that's already chosen stays put and hidden.
      const next = nextHostAfter(players.map((p) => (p.id === playerId ? { ...p, removed: true } : p)), playerId);
      room.hostId = next;
      room.controlsId = next;
      if (next) room.hostAnchor = next;
    } else {
      room.hostAnchor = playerId;
      room.hostId = null;
    }
  }

  await r.set(roomKey(code), room, { ex: TTL });
  await settleTurnAfterDeparture(code, room, before, newOrder);

  return { ok: true };
}

// Turns raw input into a single-line message: control characters (including
// line breaks) become spaces, and the ends are trimmed.
function cleanChatText(text) {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0);
    out += c < 32 || c === 127 ? " " : ch;
  }
  return out.trim();
}

// Sends a chat message. Free messages pass `{ text }`; quick statements pass
// `{ presetId }` only — the text always comes from lib/chatPresets.js on the
// server, never from the client. Anyone currently in the game may send
// (players, and so the host/organizer too); removed players, people who are
// away, and anyone whose token doesn't check out can't. Limited to
// CHAT_RATE_LIMIT messages per CHAT_RATE_WINDOW seconds per person.
export async function sendChatMessage(code, who, { text, presetId } = {}) {
  const r = redis();

  let body;
  let preset = null;
  if (presetId !== undefined && presetId !== null) {
    preset = findChatPreset(presetId);
    if (!preset) return { error: "That quick statement doesn't exist." };
    body = preset.text;
  } else {
    if (typeof text !== "string") return { error: "Type a message first." };
    if (text.length > CHAT_MAX_LENGTH * 4) return { error: `Messages can be up to ${CHAT_MAX_LENGTH} characters.` };
    body = cleanChatText(text);
    if (!body) return { error: "Type a message first." };
    if (Array.from(body).length > CHAT_MAX_LENGTH) return { error: `Messages can be up to ${CHAT_MAX_LENGTH} characters.` };
  }

  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };
  const player = await loadActor(code, who);
  if (!player) return NOT_SIGNED_IN;
  if (player.removed) return { error: "You're no longer in this game, so you can't send messages.", status: 403 };
  const playerId = player.id;

  // Fixed window: the first message starts a CHAT_RATE_WINDOW-second timer
  // (EXPIRE ... NX never extends a running one), and the counter vanishes on
  // its own when it ends.
  const rk = chatRateKey(code, playerId);
  const [count] = await r.pipeline().incr(rk).expire(rk, CHAT_RATE_WINDOW, "NX").exec();
  if (count > CHAT_RATE_LIMIT) {
    return { error: "You're sending messages too fast. Wait a few seconds and try again.", status: 429 };
  }

  const message = {
    id: crypto.randomUUID(),
    playerId,
    name: player.name,
    text: body,
    presetId: preset ? preset.id : null,
    at: Date.now(),
  };
  const ck = chatKey(code);
  await r.pipeline().rpush(ck, message).ltrim(ck, -CHAT_KEEP, -1).expire(ck, TTL).exec();
  return { ok: true, message };
}

// Only these fields ever leave the server as chat data.
function publicChat(list) {
  return (Array.isArray(list) ? list : [])
    .filter((m) => m && typeof m === "object" && typeof m.text === "string")
    .map((m) => ({ id: m.id, playerId: m.playerId, name: m.name, text: m.text, presetId: m.presetId || null, at: m.at }));
}

// What a given person is allowed to see. `who` is `{ id, token }`; without a
// valid token the viewer is anonymous (they see the public game, never a
// secret, and get no `me`). Someone who left or was removed can still read.
export async function getState(code, who) {
  const room = await getRoom(code);
  if (!room) return null;

  const allPlayers = (await getPlayers(code)).sort((a, b) => a.joinedAt - b.joinedAt);
  const candidate = who && typeof who.id === "string" ? allPlayers.find((p) => p.id === who.id) || null : null;
  const me = candidate && (await verifyToken(candidate, who.token)) ? candidate : null;
  const myId = me ? me.id : null;

  const { currentPlayerId } = await resolveTurn(code, room);
  const controlsId = await resolveControls(code, room);

  // Every "am I…" below comes from the verified `me`, never from a claimed id.
  const isHost = room.mode === "rotating" && !!me && !me.removed && room.hostId === myId;
  const isControlsHolder = !!me && !me.removed && controlsId === myId;
  // Kept for the computer-mode "organizer" badge/copy — the organizer *is*
  // whoever currently holds controls in that mode.
  const isOrganizer = room.mode === "computer" && isControlsHolder;
  const hostPlayer = room.mode === "rotating" && room.hostId ? allPlayers.find((p) => p.id === room.hostId) || null : null;
  const controlsPlayer = controlsId ? allPlayers.find((p) => p.id === controlsId) || null : null;

  // The secret is only ever sent to the rotating-mode current host, for
  // their own round, and only when their token checks out. In computer mode
  // nobody — including the organizer — ever receives it while the round is
  // live. During a hostless round (the host left mid-round) nobody holds
  // the secret at all, so nobody sees it until the round ends.
  const secret = isHost ? room.secret : null;

  // One LRANGE for the whole chat (the only Redis command chat adds to a poll),
  // sent alongside the scoreboard. Only people in the game (even ones removed
  // or who left, who can still read) get it.
  const chatPromise = me ? redis().lrange(chatKey(code), -CHAT_STATE_LIMIT, -1) : Promise.resolve([]);
  const scoreboard = await buildScoreboard(code, allPlayers);
  const rounds = (await redis().lrange(roundsKey(code), 0, -1)) || [];

  return {
    code: room.code,
    mode: room.mode,
    digits: room.digits,
    round: room.round,
    roundState: room.roundState,
    isHost,
    isOrganizer,
    isControlsHolder,
    hostId: room.mode === "rotating" ? room.hostId : null,
    hostName: hostPlayer ? hostPlayer.name : null,
    organizerName: room.mode === "computer" ? (controlsPlayer ? controlsPlayer.name : null) : null,
    controlsHolderId: controlsId,
    controlsHolderName: controlsPlayer ? controlsPlayer.name : null,
    secret,
    winner: room.winner,
    revealedSecret: room.revealedSecret,
    revealedRound: room.revealedRound,
    currentPlayerId: room.roundState === "active" ? currentPlayerId : null,
    me: me
      ? {
          id: me.id, name: me.name, history: me.history, solved: !!me.solvedAt,
          removed: !!me.removed, leaveReason: me.leaveReason || null,
        }
      : null,
    players: allPlayers.map((p) => ({
      id: p.id,
      name: p.name,
      tries: p.history.length,
      solved: !!p.solvedAt,
      removed: !!p.removed,
      leaveReason: p.leaveReason || null,
      // Everyone can see everyone's guesses and results; only the secret
      // itself, PIN data and tokens are ever kept private.
      history: p.history,
    })),
    scoreboard,
    rounds,
    chat: publicChat(await chatPromise),
  };
}
