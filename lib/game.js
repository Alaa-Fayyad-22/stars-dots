import { Redis } from "@upstash/redis";

// Rooms (and everything scoped to them) disappear automatically after 24 hours.
const TTL = 60 * 60 * 24;

// How long a host/current player can go unseen before someone else is
// allowed to step in (stuck-host fallback, stuck-player skip).
const INACTIVE_MS = 60 * 1000;

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

async function getTurnInfo(code, room) {
  const r = redis();
  const order = await r.lrange(orderKey(code), 0, -1);
  const turnOrder = turnOrderFor(room, order);
  if (!turnOrder.length) return { order, turnOrder, currentPlayerId: null };
  const stored = await r.get(turnKey(code));
  const currentPlayerId = stored && turnOrder.includes(stored) ? stored : turnOrder[0];
  return { order, turnOrder, currentPlayerId };
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
    lastSeen: now,
    removed: false,
  };
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
  player.lastSeen = now;
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

  const order = await r.lrange(orderKey(code), 0, -1);
  const turnOrder = turnOrderFor(room, order);
  if (turnOrder.length) await r.set(turnKey(code), turnOrder[0], { ex: TTL });
  else await r.del(turnKey(code));

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

  const { turnOrder, currentPlayerId } = await getTurnInfo(code, room);
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
  player.lastSeen = Date.now();
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

      if (room.mode === "rotating") {
        // Winner becomes host of the next round, which starts out pending
        // until they pick a new number. Guess histories stay put (so the
        // winning guess stays visible) until pickSecret() actually starts
        // the new round.
        room.round += 1;
        room.hostId = playerId;
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

  const idx = turnOrder.indexOf(playerId);
  const nextPlayerId = turnOrder.length ? turnOrder[(idx + 1) % turnOrder.length] : null;
  if (nextPlayerId) await r.set(turnKey(code), nextPlayerId, { ex: TTL });
  return { result };
}

// Skip the current turn. The current host/organizer can always do this
// while a round is active. Anyone else can only do it as a stuck-player
// fallback, once the current player has gone unseen for 60+ seconds.
export async function skipTurn(code, playerId) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };
  if (room.roundState !== "active") return { error: "There's no active turn to skip right now." };

  const requester = await r.hget(playersKey(code), playerId);
  if (!requester || requester.removed) return { error: "You've been removed from this game." };

  const { turnOrder, currentPlayerId } = await getTurnInfo(code, room);
  if (!turnOrder.length || !currentPlayerId) return { error: "No players to skip to yet." };

  const isHostOrOrganizer = room.mode === "rotating" ? room.hostId === playerId : room.creatorId === playerId;
  if (!isHostOrOrganizer) {
    const current = await r.hget(playersKey(code), currentPlayerId);
    const stale = !current || !current.lastSeen || Date.now() - current.lastSeen > INACTIVE_MS;
    if (!stale) return { error: "Only the host can skip a turn right now." };
  }

  const idx = turnOrder.indexOf(currentPlayerId);
  const nextPlayerId = turnOrder[(idx + 1) % turnOrder.length];
  await r.set(turnKey(code), nextPlayerId, { ex: TTL });
  return { ok: true };
}

export async function removePlayer(code, requesterId, targetPlayerId) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };

  const isHostOrOrganizer = room.mode === "rotating" ? room.hostId === requesterId : room.creatorId === requesterId;
  if (!isHostOrOrganizer) return { error: "Only the host can remove a player." };

  const order = await r.lrange(orderKey(code), 0, -1);
  if (!order.includes(targetPlayerId)) return { error: "That player isn't in this game." };

  const { turnOrder, currentPlayerId } = await getTurnInfo(code, room);

  const player = await r.hget(playersKey(code), targetPlayerId);
  if (player) {
    player.removed = true;
    await r.hset(playersKey(code), { [targetPlayerId]: player });
    await r.expire(playersKey(code), TTL);
  }
  await r.lrem(orderKey(code), 0, targetPlayerId);

  const newOrder = order.filter((id) => id !== targetPlayerId);
  let roomChanged = false;
  if (room.mode === "rotating" && room.hostId === targetPlayerId) {
    const hostIdx = order.indexOf(targetPlayerId);
    room.hostId = newOrder.length ? newOrder[hostIdx % newOrder.length] : null;
    roomChanged = true;
  }
  if (roomChanged) await r.set(roomKey(code), room, { ex: TTL });

  // Recompute the turn order fresh, since a host change (above) can itself
  // change who's excluded from it.
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

// The host (rotating) or organizer (computer) ends the round with no
// winner. The secret is revealed to everyone, and nobody scores.
export async function endRound(code, playerId) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };
  if (room.roundState !== "active") return { error: "There's no active round to end." };

  const isHostOrOrganizer = room.mode === "rotating" ? room.hostId === playerId : room.creatorId === playerId;
  if (!isHostOrOrganizer) {
    return { error: room.mode === "rotating" ? "Only the host can end the round." : "Only the organizer can end the round." };
  }

  room.winner = null;
  room.revealedSecret = room.secret;
  room.revealedRound = room.round;
  room.roundState = "ended";

  if (room.mode === "rotating") {
    const order = await r.lrange(orderKey(code), 0, -1);
    const idx = order.indexOf(room.hostId);
    room.round += 1;
    room.hostId = order.length ? order[(idx === -1 ? 0 : idx + 1) % order.length] : null;
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
  if (!claimed) return { ok: true };

  room.round = nextRound;
  room.secret = randomSecret(room.digits);
  room.winner = null;
  room.roundState = "active";
  room.revealedSecret = null;
  room.revealedRound = null;
  await r.set(roomKey(code), room, { ex: TTL });
  await resetHistories(code);

  const order = await r.lrange(orderKey(code), 0, -1);
  if (order.length) await r.set(turnKey(code), order[0], { ex: TTL });
  else await r.del(turnKey(code));

  return { ok: true };
}

// Rotating mode's stuck-host fallback: if the current host hasn't polled in
// 60+ seconds and hasn't picked a number yet, anyone can pass hosting to the
// next player in join order.
export async function makeNextHost(code, playerId) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };
  if (room.mode !== "rotating") return { error: "This mode doesn't have a rotating host." };
  if (room.roundState !== "pending") return { error: "The host has already picked a number." };
  if (!room.hostId) return { error: "There's no host to replace yet." };

  const requester = await r.hget(playersKey(code), playerId);
  if (!requester || requester.removed) return { error: "You've been removed from this game." };

  const host = await r.hget(playersKey(code), room.hostId);
  const stale = !host || !host.lastSeen || Date.now() - host.lastSeen > INACTIVE_MS;
  if (!stale) return { error: "The host is still active — give them a moment." };

  const order = await r.lrange(orderKey(code), 0, -1);
  const idx = order.indexOf(room.hostId);
  const nextHost = order.length ? order[(idx === -1 ? 0 : idx + 1) % order.length] : null;
  if (!nextHost || nextHost === room.hostId) return { error: "No other players to make host." };

  room.hostId = nextHost;
  await r.set(roomKey(code), room, { ex: TTL });
  return { ok: true };
}

// What a given person is allowed to see. Also doubles as the heartbeat: a
// poll from a known, non-removed player refreshes their `lastSeen`.
export async function getState(code, playerId) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return null;

  const allPlayers = (await getPlayers(code)).sort((a, b) => a.joinedAt - b.joinedAt);
  const me = playerId ? allPlayers.find((p) => p.id === playerId) || null : null;

  if (me && !me.removed) {
    me.lastSeen = Date.now();
    await r.hset(playersKey(code), { [me.id]: me });
    await r.expire(playersKey(code), TTL);
  }

  const { currentPlayerId } = await getTurnInfo(code, room);
  const now = Date.now();

  let hostInactive = false;
  if (room.mode === "rotating" && room.roundState === "pending" && room.hostId) {
    const host = allPlayers.find((p) => p.id === room.hostId);
    hostInactive = !host || !host.lastSeen || now - host.lastSeen > INACTIVE_MS;
  }
  let currentPlayerInactive = false;
  if (room.roundState === "active" && currentPlayerId) {
    const current = allPlayers.find((p) => p.id === currentPlayerId);
    currentPlayerInactive = !current || !current.lastSeen || now - current.lastSeen > INACTIVE_MS;
  }

  const isHost = room.mode === "rotating" && !!playerId && room.hostId === playerId;
  const isOrganizer = !!playerId && room.creatorId === playerId;
  const hostPlayer = room.mode === "rotating" ? allPlayers.find((p) => p.id === room.hostId) || null : null;
  const organizerPlayer = allPlayers.find((p) => p.id === room.creatorId) || null;

  // The secret is only ever sent to the rotating-mode current host, for
  // their own round. In computer mode nobody — including the organizer —
  // ever receives it while the round is live.
  const secret = room.mode === "rotating" && isHost && me && !me.removed ? room.secret : null;

  const scoreboard = await buildScoreboard(code, allPlayers);

  return {
    code: room.code,
    mode: room.mode,
    digits: room.digits,
    round: room.round,
    roundState: room.roundState,
    isHost,
    isOrganizer,
    hostName: hostPlayer ? hostPlayer.name : null,
    hostInactive,
    organizerName: organizerPlayer ? organizerPlayer.name : null,
    currentPlayerInactive,
    secret,
    winner: room.winner,
    revealedSecret: room.revealedSecret,
    revealedRound: room.revealedRound,
    currentPlayerId: room.roundState === "active" ? currentPlayerId : null,
    me: me
      ? { id: me.id, name: me.name, history: me.history, solved: !!me.solvedAt, removed: !!me.removed }
      : null,
    players: allPlayers.map((p) => ({
      id: p.id,
      name: p.name,
      tries: p.history.length,
      solved: !!p.solvedAt,
      removed: !!p.removed,
      // Everyone can see everyone's guesses and results; only the secret
      // itself, and PIN data, are ever kept private.
      history: p.history,
    })),
    scoreboard,
  };
}
