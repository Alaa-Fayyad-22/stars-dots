import { Redis } from "@upstash/redis";

// Rooms disappear automatically after 24 hours
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

// 4 different digits, not starting with 0 (so it can't be typed/read as a
// shorter number).
export function isFourDigits(value) {
  return typeof value === "string" && /^[1-9]\d{3}$/.test(value) && new Set(value).size === 4;
}

export function cleanName(name) {
  return String(name || "").trim().slice(0, 20);
}

// Same rules as the Python version
export function checkGuess(secret, guess) {
  let stars = 0;
  for (let i = 0; i < 4; i++) if (secret[i] === guess[i]) stars++;
  let common = 0;
  for (const d of new Set(guess)) {
    const inSecret = secret.split(d).length - 1;
    const inGuess = guess.split(d).length - 1;
    common += Math.min(inSecret, inGuess);
  }
  return { stars, dots: common - stars };
}

function newCode() {
  // No look-alike characters (0/O, 1/I)
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export async function createRoom(hostName, secret) {
  const r = redis();
  const hostId = crypto.randomUUID();
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    const room = { code, hostId, hostName, secret, round: 1, winner: null, createdAt: Date.now() };
    // NX makes the check-and-create atomic: if this code is somehow already
    // taken (a prior room, or a concurrent create() landing on the same
    // random code), this fails instead of silently overwriting it, and we
    // just try again with a fresh code.
    const created = await r.set(roomKey(code), room, { nx: true, ex: TTL });
    if (created) return { code, playerId: hostId };
  }
  throw new Error("Couldn't generate a unique game code. Please try again.");
}

export async function getRoom(code) {
  return redis().get(roomKey(code));
}

export async function joinRoom(code, name) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return null;
  const playerId = crypto.randomUUID();
  const player = { id: playerId, name, history: [], solvedAt: null, joinedAt: Date.now() };
  await r.hset(playersKey(code), { [playerId]: player });
  await r.rpush(`room:${code}:order`, playerId);
  await r.expire(playersKey(code), TTL);
  await r.expire(orderKey(code), TTL);
  return { playerId };
}

// The current player is tracked by id, not by a counter reinterpreted
// against the (possibly-grown-since) order list — that's what let the turn
// silently jump to someone else whenever a new player joined mid-round. If
// the stored id ever isn't in `order` (shouldn't normally happen, but is a
// safe fallback), default to the first player rather than getting stuck.
async function getTurnInfo(code) {
  const r = redis();
  const order = await r.lrange(orderKey(code), 0, -1);
  if (!order.length) return { order, currentPlayerId: null };
  const stored = await r.get(turnKey(code));
  const currentPlayerId = stored && order.includes(stored) ? stored : order[0];
  return { order, currentPlayerId };
}

async function currentTurn(code) {
  return (await getTurnInfo(code)).currentPlayerId;
}

async function getPlayers(code) {
  const all = (await redis().hgetall(playersKey(code))) || {};
  return Object.values(all);
}

export async function submitGuess(code, playerId, guess) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };
  if (room.winner) return { error: "The round is over." };

  const player = await r.hget(playersKey(code), playerId);
  if (!player) return { error: "Join the game before guessing." };
  if (player.removed) return { error: "You've been removed from this game." };

  const { order, currentPlayerId } = await getTurnInfo(code);
  if (currentPlayerId !== playerId) {
    return { error: "It's not your turn." };
  }

  // Guard against a double-tap (or any concurrent duplicate request) firing
  // two guesses for the same turn: this player's own guess count (read just
  // above, before this guess is added) is a deterministic stand-in for
  // "which turn of theirs this is" — two concurrent requests for the same
  // turn compute the same claim key, and only the first SET NX wins. Scoped
  // by round, since history is cleared on every new round.
  const claimed = await r.set(`room:${code}:turnclaim:${room.round}:${playerId}:${player.history.length}`, "1", { nx: true, ex: TTL });
  if (!claimed) return { error: "It's not your turn." };

  const result = checkGuess(room.secret, guess);
  player.history.push({ guess, ...result, at: Date.now() });

  if (result.stars === 4) {
    player.solvedAt = Date.now();
    const wonClaim = await r.set(`${roomKey(code)}:winner:${room.round}`, playerId, { nx: true, ex: TTL });
    if (wonClaim) {
      room.winner = { id: playerId, name: player.name, tries: player.history.length };
      await r.set(roomKey(code), room, { ex: TTL });
    }
  }

  await r.hset(playersKey(code), { [playerId]: player });

  const idx = order.indexOf(playerId);
  const nextPlayerId = order[(idx + 1) % order.length];
  await r.set(turnKey(code), nextPlayerId, { ex: TTL });

  return { result };
}

// Host-only: move the turn along without a guess, e.g. when someone leaves.
export async function skipTurn(code, playerId) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };
  if (room.hostId !== playerId) return { error: "Only the host can skip a turn." };
  if (room.winner) return { error: "The round is already over." };

  const { order, currentPlayerId } = await getTurnInfo(code);
  if (!order.length) return { error: "No players to skip to yet." };

  const idx = order.indexOf(currentPlayerId);
  const nextPlayerId = order[(idx + 1) % order.length];
  await r.set(turnKey(code), nextPlayerId, { ex: TTL });
  return { ok: true };
}

// Host-only: remove a player entirely (e.g. they left and aren't coming
// back). They're taken out of the turn order and, if it was their turn, the
// turn passes to whoever is next. Their player record stays (so their past
// guesses remain visible, flagged as `removed`) — only their seat in the
// rotation is gone.
export async function removePlayer(code, hostPlayerId, targetPlayerId) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };
  if (room.hostId !== hostPlayerId) return { error: "Only the host can remove a player." };

  const order = await r.lrange(orderKey(code), 0, -1);
  const idx = order.indexOf(targetPlayerId);
  if (idx === -1) return { error: "That player isn't in this game." };

  // Read whose turn it is BEFORE removing them, using the still-intact order.
  const { currentPlayerId } = await getTurnInfo(code);
  const wasCurrent = currentPlayerId === targetPlayerId;

  const player = await r.hget(playersKey(code), targetPlayerId);
  if (player) {
    player.removed = true;
    await r.hset(playersKey(code), { [targetPlayerId]: player });
  }
  await r.lrem(orderKey(code), 0, targetPlayerId);

  if (wasCurrent) {
    const remaining = order.filter((id) => id !== targetPlayerId);
    if (remaining.length) {
      // Whoever was next after the removed player's old spot in the
      // rotation (wrapping around) becomes current.
      const nextPlayerId = remaining[idx % remaining.length];
      await r.set(turnKey(code), nextPlayerId, { ex: TTL });
    } else {
      await r.del(turnKey(code));
    }
  }

  return { ok: true };
}

export async function newRound(code, playerId, secret) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };
  if (room.hostId !== playerId) return { error: "Only the host can start a new round." };

  room.secret = secret;
  room.round += 1;
  room.winner = null;
  await r.set(roomKey(code), room, { ex: TTL });

  const order = await r.lrange(orderKey(code), 0, -1);
  if (order.length) {
    await r.set(turnKey(code), order[0], { ex: TTL });
  } else {
    await r.del(turnKey(code));
  }

  const players = await getPlayers(code);
  if (players.length) {
    const reset = {};
    for (const p of players) reset[p.id] = { ...p, history: [], solvedAt: null };
    await r.hset(playersKey(code), reset);
  }
  return { ok: true };
}

// What a given person is allowed to see
export async function getState(code, playerId) {
  const room = await getRoom(code);
  if (!room) return null;
  const players = (await getPlayers(code)).sort((a, b) => a.joinedAt - b.joinedAt);
  const isHost = room.hostId === playerId;
  const me = players.find((p) => p.id === playerId) || null;

  return {
    code: room.code,
    round: room.round,
    hostName: room.hostName,
    isHost,
    secret: isHost ? room.secret : null,
    winner: room.winner,
    currentPlayerId: await currentTurn(code),
    me: me ? { name: me.name, history: me.history, solved: !!me.solvedAt, removed: !!me.removed } : null,
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      tries: p.history.length,
      solved: !!p.solvedAt,
      removed: !!p.removed,
      // Everyone can see everyone's guesses and results; only the secret itself is host-only.
      history: p.history,
    })),
  };
}
