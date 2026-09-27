import { Redis } from "@upstash/redis";

// Rooms disappear automatically after 24 hours
const TTL = 60 * 60 * 24;

let client;
function redis() {
  if (!client) {
    client = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
    });
  }
  return client;
}

const roomKey = (code) => `room:${code}`;
const playersKey = (code) => `room:${code}:players`;

export function isFourDigits(value) {
  return typeof value === "string" && /^\d{4}$/.test(value);
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
  await r.expire(playersKey(code), TTL);
  return { playerId };
}

async function getPlayers(code) {
  const all = (await redis().hgetall(playersKey(code))) || {};
  return Object.values(all);
}

export async function submitGuess(code, playerId, guess) {
  const r = redis();
  const room = await getRoom(code);
  if (!room) return { error: "This game no longer exists." };
  const player = await r.hget(playersKey(code), playerId);
  if (!player) return { error: "Join the game before guessing." };
  if (player.solvedAt) return { error: "You already found the number." };

  const result = checkGuess(room.secret, guess);
  player.history.push({ guess, ...result, at: Date.now() });

  if (result.stars === 4) {
    player.solvedAt = Date.now();
    // Only the first player to solve it becomes the winner
    if (!room.winner) {
      const claimed = await r.set(`${roomKey(code)}:winner:${room.round}`, playerId, { nx: true, ex: TTL });
      if (claimed) {
        room.winner = { id: playerId, name: player.name, tries: player.history.length };
        await r.set(roomKey(code), room, { ex: TTL });
      }
    }
  }

  // Each player only writes their own entry, so simultaneous guesses never overwrite each other
  await r.hset(playersKey(code), { [playerId]: player });
  return { result };
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
