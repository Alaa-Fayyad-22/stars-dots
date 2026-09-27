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

export function isFourDigits(value) {
  return typeof value === "string" && /^\d{4}$/.test(value) && new Set(value).size === 4;
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
  let code;
  for (let i = 0; i < 5; i++) {
    code = newCode();
    if (!(await r.exists(roomKey(code)))) break;
  }
  const hostId = crypto.randomUUID();
  const room = { code, hostId, hostName, secret, round: 1, winner: null, createdAt: Date.now() };
  await r.set(roomKey(code), room, { ex: TTL });
  return { code, playerId: hostId };
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
  return { playerId };
}

async function getTurnInfo(code) {
  const r = redis();
  const order = await r.lrange(`room:${code}:order`, 0, -1);
  const turnNumber = Number(await r.get(`room:${code}:turn`)) || 0;
  const currentPlayerId = order.length ? order[turnNumber % order.length] : null;
  return { order, turnNumber, currentPlayerId };
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

  const { currentPlayerId, turnNumber } = await getTurnInfo(code);
  if (currentPlayerId !== playerId) {
    return { error: "It's not your turn." };
  }

  // Guard against a double-tap (or any concurrent duplicate request) firing
  // two guesses for the same turn: only the first request to claim this
  // turn number is allowed to proceed. Scoped by round, since the turn
  // counter itself is reset to 0 on every new round.
  const claimed = await r.set(`room:${code}:turnclaim:${room.round}:${turnNumber}`, playerId, { nx: true, ex: TTL });
  if (!claimed) return { error: "It's not your turn." };

  const result = checkGuess(room.secret, guess);
  player.history.push({ guess, ...result, at: Date.now() });

  if (result.stars === 4) {
    player.solvedAt = Date.now();
    const claimed = await r.set(`${roomKey(code)}:winner:${room.round}`, playerId, { nx: true, ex: TTL });
    if (claimed) {
      room.winner = { id: playerId, name: player.name, tries: player.history.length };
      await r.set(roomKey(code), room, { ex: TTL });
    }
  }

  await r.hset(playersKey(code), { [playerId]: player });
  await r.incr(`room:${code}:turn`);   // next player's turn
  return { result };
}

// Host-only: move the turn along without a guess, e.g. when someone leaves.
export async function skipTurn(code, playerId) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };
  if (room.hostId !== playerId) return { error: "Only the host can skip a turn." };
  if (room.winner) return { error: "The round is already over." };

  const players = await getPlayers(code);
  if (!players.length) return { error: "No players to skip to yet." };

  await r.incr(`room:${code}:turn`);
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
  await r.set(`room:${code}:turn`, 0); 

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
    me: me ? { name: me.name, history: me.history, solved: !!me.solvedAt } : null,
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      tries: p.history.length,
      solved: !!p.solvedAt,
      // The host watches every guess live; players only see how many tries others took
      history: isHost ? p.history : undefined,
    })),
  };
}
