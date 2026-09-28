import { Redis } from "@upstash/redis";


// Rooms (and everything scoped to them) disappear automatically after 24 hours.
const TTL = 60 * 60 * 24;

// Vercel integrations prefix these env var names differently depending on
// how the Upstash/KV store was connected (e.g. STORAGE_UPSTASH_REDIS_REST_URL).
// Find whichever key ends with the suffix we need, then look for its
// same-prefixed token counterpart.
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
const roundsKey = (code) => `room:${code}:rounds`;

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
// at someone who isn't eligible right now (removed, the current host, or
// otherwise not in the live turn order), the correct value is computed fresh
// from the live order and immediately written back — so the fix is visible
// to every reader from that point on, not just this call.
async function resolveTurn(code, room) {
  const r = redis();
  const order = await r.lrange(orderKey(code), 0, -1);
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
// everyone) before the next round clears the guess histories.
async function recordRound(code, room, winner) {
  const r = redis();
  const players = await getPlayers(code);
  const totalTries = players.reduce((sum, p) => sum + p.history.length, 0);
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
    return { id: p.id, name: p.name, removed: !!p.removed, wins: s.wins, avgTries };
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

function newPlayer({ id, name, pinHash, pinSalt, now }) {
  return {
    id,
    name,
    nameLower: name.toLowerCase(),
    pinHash,
    pinSalt,
    pinFails: 0,
    pinLockUntil: null,
    history: [],
    solvedAt: null,
    joinedAt: now,
    removed: false,
    leaveReason: null, // null | "removed" | "left"
  };
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
  const order = await r.lrange(orderKey(code), 0, -1);
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

    const player = newPlayer({ id: creatorId, name: hostName, pinHash: hash, pinSalt: salt, now });
    await r.hset(playersKey(code), { [creatorId]: player });
    await r.expire(playersKey(code), TTL);
    await r.rpush(orderKey(code), creatorId);
    await r.expire(orderKey(code), TTL);
    await r.hsetnx(namesKey(code), hostName.toLowerCase(), creatorId);
    await r.expire(namesKey(code), TTL);
    if (mode === "computer") {
      await r.set(turnKey(code), creatorId, { ex: TTL });
    }
    return { code, playerId: creatorId };
  }
  throw new Error("Couldn't generate a unique game code. Please try again.");
}

export async function joinRoom(code, name, pin) {
  const playerName = cleanName(name);
  if (!playerName) return { error: "Enter your name." };
  if (!isValidPin(pin)) return { error: "Pick a 4-digit PIN." };

  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "No game found with that code." };

  const nameLower = playerName.toLowerCase();
  const playerId = crypto.randomUUID();
  const claimed = await r.hsetnx(namesKey(code), nameLower, playerId);
  await r.expire(namesKey(code), TTL);
  if (!claimed) return { error: "That name is already taken in this game." };

  const { hash, salt } = await hashPin(pin);
  const now = Date.now();
  const player = newPlayer({ id: playerId, name: playerName, pinHash: hash, pinSalt: salt, now });
  await r.hset(playersKey(code), { [playerId]: player });
  await r.expire(playersKey(code), TTL);
  await r.rpush(orderKey(code), playerId);
  await r.expire(orderKey(code), TTL);

  // A late joiner is added at the end of the turn order automatically (the
  // turn order is always computed live from this list). But if the game had
  // nobody left holding controls (the host/organizer left and no one else
  // was around), this joiner picks controls up — and, in rotating mode with
  // a round waiting to start, becomes the host who picks the number.
  if (!room.controlsId) {
    room.controlsId = playerId;
    if (room.mode === "rotating" && room.roundState === "pending" && !room.hostId) {
      room.hostId = playerId;
    }
    await r.set(roomKey(code), room, { ex: TTL });
  }

  return { playerId };
}

export async function rejoinRoom(code, name, pin) {
  const playerName = cleanName(name);
  if (!playerName) return { error: "Enter your name." };
  if (!isValidPin(pin)) return { error: "Enter your 4-digit PIN." };

  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "No game found with that code." };

  const nameLower = playerName.toLowerCase();
  const playerId = await r.hget(namesKey(code), nameLower);
  if (!playerId) return { error: "No player with that name in this game." };
  const player = await r.hget(playersKey(code), playerId);
  if (!player) return { error: "No player with that name in this game." };
  if (player.removed) return { error: "That player was removed and can't rejoin." };

  const now = Date.now();
  if (player.pinLockUntil && now < player.pinLockUntil) {
    const mins = Math.max(1, Math.ceil((player.pinLockUntil - now) / 60000));
    return { error: `Too many attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.` };
  }

  const { hash } = await hashPin(pin, player.pinSalt);
  if (hash !== player.pinHash) {
    player.pinFails = (player.pinFails || 0) + 1;
    let error;
    if (player.pinFails >= 5) {
      player.pinLockUntil = now + 5 * 60 * 1000;
      player.pinFails = 0;
      error = "Too many attempts. Try again in 5 minutes.";
    } else {
      const left = 5 - player.pinFails;
      error = `Wrong PIN. ${left} attempt${left === 1 ? "" : "s"} left.`;
    }
    await r.hset(playersKey(code), { [playerId]: player });
    await r.expire(playersKey(code), TTL);
    return { error };
  }

  player.pinFails = 0;
  player.pinLockUntil = null;
  await r.hset(playersKey(code), { [playerId]: player });
  await r.expire(playersKey(code), TTL);
  return { playerId };
}

// Rotating mode only: the current host picks the secret and starts the round.
export async function pickSecret(code, playerId, secret) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };
  if (room.mode !== "rotating") return { error: "This game picks its own numbers." };
  if (room.roundState !== "pending") return { error: "The number for this round is already set." };
  if (room.hostId !== playerId) return { error: "Only the current host can pick the number." };

  const player = await r.hget(playersKey(code), playerId);
  if (!player || player.removed) return { error: "You've been removed from this game." };
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

export async function submitGuess(code, playerId, guess) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };
  if (!isValidSecret(guess, room.digits)) {
    return { error: `A guess must use ${room.digits} different digits, not starting with 0.` };
  }
  if (room.roundState === "pending") return { error: "Waiting for the host to pick a number." };
  if (room.roundState === "ended") return { error: "The round is over." };

  const player = await r.hget(playersKey(code), playerId);
  if (!player) return { error: "Join the game before guessing." };
  if (player.removed) return { error: "You've been removed from this game." };
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
      const who = p.id === playerId ? "You" : p.name;
      return { error: `${who} already tried this: ${describePegs(prior.stars, prior.dots)}` };
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
      await recordRound(code, room, room.winner);

      if (room.mode === "rotating") {
        // Winner becomes host of the next round, which starts out pending
        // until they pick a new number. Guess histories stay put (so the
        // winning guess stays visible) until pickSecret() actually starts
        // the new round. The winner also picks up host/organizer controls,
        // even if the round they just won was hostless.
        room.round += 1;
        room.hostId = playerId;
        room.controlsId = playerId;
        room.roundState = "pending";
        room.secret = null;
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
export async function skipTurn(code, playerId) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };
  if (room.roundState !== "active") return { error: "There's no active turn to skip right now." };

  const requester = await r.hget(playersKey(code), playerId);
  if (!requester || requester.removed) return { error: "You've been removed from this game." };

  const controlsId = await resolveControls(code, room);
  if (controlsId !== playerId) {
    return { error: room.mode === "rotating" ? "Only the host can skip a turn." : "Only the organizer can skip a turn." };
  }

  const { turnOrder, currentPlayerId } = await resolveTurn(code, room);
  if (!turnOrder.length || !currentPlayerId) return { error: "No players to skip to yet." };

  await advanceTurn(code, room, currentPlayerId);
  return { ok: true };
}

// Only the current host/organizer can remove a player — never themselves
// (that's what "Leave game" is for), and never the host/organizer seat
// itself, which can only ever change hands via leaveGame() or by winning a
// round.
export async function removePlayer(code, requesterId, targetPlayerId) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };
  if (requesterId === targetPlayerId) return { error: "You can't remove yourself — use \"Leave game\" instead." };

  const controlsId = await resolveControls(code, room);
  if (controlsId !== requesterId) {
    return { error: room.mode === "rotating" ? "Only the host can remove a player." : "Only the organizer can remove a player." };
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

  const order = await r.lrange(orderKey(code), 0, -1);
  if (!order.includes(targetPlayerId)) return { error: "That player isn't in this game." };

  const { turnOrder, currentPlayerId } = await resolveTurn(code, room);

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
  const newOrder = order.filter((id) => id !== targetPlayerId);
  const newTurnOrder = turnOrderFor(room, newOrder);
  if (newTurnOrder.length) {
    let nextTurn = currentPlayerId;
    if (!newTurnOrder.includes(currentPlayerId)) {
      const oldIdx = turnOrder.indexOf(currentPlayerId);
      nextTurn = newTurnOrder[(oldIdx === -1 ? 0 : oldIdx) % newTurnOrder.length];
    }
    await r.set(turnKey(code), nextTurn, { ex: TTL });
  } else {
    await r.del(turnKey(code));
  }

  return { ok: true };
}


// The current host/organizer brings back a player they removed. Only works
// for players who were removed, not for someone who left on their own.
// The restored player keeps their name, PIN, history, and score, and is
// added at the end of the turn order.
export async function restorePlayer(code, requesterId, targetPlayerId) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };

  const controlsId = await resolveControls(code, room);
  if (controlsId !== requesterId) {
    return { error: room.mode === "rotating" ? "Only the host can restore a player." : "Only the organizer can restore a player." };
  }

  const player = await r.hget(playersKey(code), targetPlayerId);
  if (!player) return { error: "That player isn't in this game." };
  if (!player.removed) return { error: "That player is already in the game." };
  if (player.leaveReason !== "removed") return { error: "Players who left on their own can't be restored." };

  player.removed = false;
  player.leaveReason = null;
  player.pinFails = 0;
  player.pinLockUntil = null;
  await r.hset(playersKey(code), { [targetPlayerId]: player });
  await r.expire(playersKey(code), TTL);

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
export async function endRound(code, playerId) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };
  if (room.roundState !== "active") return { error: "There's no active round to end." };

  const controlsId = await resolveControls(code, room);
  if (controlsId !== playerId) {
    return { error: room.mode === "rotating" ? "Only the host can end the round." : "Only the organizer can end the round." };
  }

  room.winner = null;
  room.revealedSecret = room.secret;
  room.revealedRound = room.round;
  room.roundState = "ended";
  await recordRound(code, room, null);

  if (room.mode === "rotating") {
    room.round += 1;
    if (room.hostId) {
      // Normal end-round: hosting rotates to the next player in join order,
      // same as when nobody wins.
      const order = await r.lrange(orderKey(code), 0, -1);
      const idx = order.indexOf(room.hostId);
      room.hostId = order.length ? order[(idx === -1 ? 0 : idx + 1) % order.length] : null;
    } else {
      // Hostless round (the host left mid-round): whoever was holding the
      // controls — the person who just ended it — becomes the next host.
      room.hostId = controlsId;
    }
    room.controlsId = room.hostId;
    room.roundState = "pending";
    room.secret = null;
    // Guess histories stay put until pickSecret() starts the new round.
    await r.del(turnKey(code));
  }

  await r.set(roomKey(code), room, { ex: TTL });
  return { ok: true };
}

// Computer mode only: any active player starts the next round once the
// current one has ended. `roundStartClaimKey` makes sure two people
// pressing "Next round" at once only starts one round.
export async function newRound(code, playerId) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };
  if (room.mode !== "computer") return { error: "This mode starts rounds automatically." };
  if (room.roundState !== "ended") return { error: "The current round hasn't ended yet." };

  const player = await r.hget(playersKey(code), playerId);
  if (!player || player.removed) return { error: "You've been removed from this game." };

  const nextRound = room.round + 1;
  const claimed = await r.set(roundStartClaimKey(code, nextRound), "1", { nx: true, ex: TTL });
  const roundsKey = (code) => `room:${code}:rounds`;
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

// The current host (rotating) or organizer (computer) leaves for good —
// the only way either seat changes hands other than winning a round. Unlike
// removePlayer(), this can target yourself, because it's the one path that's
// *for* leaving your own controls seat.
//
// Rotating mode:
//  - mid-round: the round goes hostless. The secret stays exactly as it
//    was, hidden from everyone (nobody picks it up), and everyone else
//    keeps their turn and history. The next non-removed player in join
//    order picks up host/organizer controls (skip/remove/end round) but
//    does NOT become host — they keep playing and guessing normally.
//  - between rounds (pending, waiting for a number): the next non-removed
//    player in join order becomes host immediately and picks the number.
//  - hostless round, the controls-holder (not the actual host) leaves: the
//    round stays hostless, controls just pass on to the next player.
// Computer mode: controls (skip/remove/end round) pass to the next
// non-removed player in join order. They keep playing normally either way.
export async function leaveGame(code, playerId) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };

  const player = await r.hget(playersKey(code), playerId);
  if (!player || player.removed) return { error: "You've already left this game." };

  const isCurrentHost = room.mode === "rotating" && room.hostId === playerId;
  const isControlsHolder = room.controlsId === playerId;
  if (!isCurrentHost && !isControlsHolder) {
    return { error: room.mode === "rotating" ? "Only the current host can leave this way." : "Only the organizer can leave this way." };
  }

  player.removed = true;
  player.leaveReason = "left";
  await r.hset(playersKey(code), { [playerId]: player });
  await r.expire(playersKey(code), TTL);
  await r.lrem(orderKey(code), 0, playerId);

  const remainingOrder = await r.lrange(orderKey(code), 0, -1);
  const nextControls = remainingOrder[0] || null;
  room.controlsId = nextControls;

  if (room.mode === "rotating" && room.hostId === playerId) {
    // Between rounds, the next player must become host right away so they
    // can pick a number. Mid-round, the round simply goes hostless — the
    // secret that's already chosen stays put and hidden.
    room.hostId = room.roundState === "pending" ? nextControls : null;
  }

  await r.set(roomKey(code), room, { ex: TTL });
  // The departing player is gone from the turn order too (they're lrem'd
  // above); repair the stored turn against the live order/host either way.
  await resolveTurn(code, room);

  return { ok: true };
}

// What a given person is allowed to see.
export async function getState(code, playerId) {
  const room = await getRoom(code);
  if (!room) return null;

  const allPlayers = (await getPlayers(code)).sort((a, b) => a.joinedAt - b.joinedAt);
  const me = playerId ? allPlayers.find((p) => p.id === playerId) || null : null;

  const { currentPlayerId } = await resolveTurn(code, room);
  const controlsId = await resolveControls(code, room);

  const isHost = room.mode === "rotating" && !!playerId && room.hostId === playerId;
  const isControlsHolder = !!playerId && controlsId === playerId;
  // Kept for the computer-mode "organizer" badge/copy — the organizer *is*
  // whoever currently holds controls in that mode.
  const isOrganizer = room.mode === "computer" && isControlsHolder;
  const hostPlayer = room.mode === "rotating" && room.hostId ? allPlayers.find((p) => p.id === room.hostId) || null : null;
  const controlsPlayer = controlsId ? allPlayers.find((p) => p.id === controlsId) || null : null;

  // The secret is only ever sent to the rotating-mode current host, for
  // their own round. In computer mode nobody — including the organizer —
  // ever receives it while the round is live. During a hostless round
  // (the host left mid-round) nobody holds the secret at all, so nobody
  // sees it until the round ends.
  const secret = room.mode === "rotating" && isHost && me && !me.removed ? room.secret : null;

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
      // itself, and PIN data, are ever kept private.
      history: p.history,
    })),
    scoreboard,
    rounds
  };
}
