import { createGameWithPlayers, rawRoom, randomValidNumber } from "./helpers.js";

const TTL = 60 * 60 * 24;

function keysExpiredWithTTL(log) {
  const expiring = new Set();
  for (const entry of log) {
    if (entry.cmd === "expire") {
      const seconds = Number(entry.args[1]);
      if (seconds === TTL) expiring.add(entry.key);
    }
    if (entry.cmd === "set") {
      const opts = entry.args.slice(2).map((v) => String(v).toLowerCase());
      const exIdx = opts.indexOf("ex");
      if (exIdx !== -1 && Number(entry.args[2 + exIdx + 1]) === TTL) expiring.add(entry.key);
    }
  }
  return expiring;
}

function mutatedKeys(log) {
  const mutated = new Set();
  for (const entry of log) {
    if (["set", "hset", "hsetnx", "rpush"].includes(entry.cmd)) mutated.add(entry.key);
  }
  return mutated;
}

export default async function run({ game, fake, T }) {
  T.suite("Every Redis key carries a 24-hour expiry");

  await T.test("every key mutated across a representative game session has a 24h expiry logged", async () => {
    // Rotating mode: exercises room/players/order/turn/names + a win (scores
    // + winner-claim key) + a pending-round pick + a turnclaim key.
    const rot = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 3 });
    const room1 = rawRoom(fake, rot.code);
    const secret1 = randomValidNumber(4);
    await game.pickSecret(rot.code, room1.hostId, secret1);
    const s1 = await game.getState(rot.code, rot.players[0].id);
    await game.submitGuess(rot.code, s1.currentPlayerId, secret1);
    await game.rejoinRoom(rot.code, rot.players[1].name, "1111");
    // leaveGame(): exercises the hostless-round path too.
    const room1b = rawRoom(fake, rot.code);
    if (room1b.hostId) await game.leaveGame(rot.code, room1b.hostId);

    // Computer mode: exercises the roundstart-claim key via newRound(), plus
    // an end-round-with-no-winner pass.
    const comp = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const room2 = rawRoom(fake, comp.code);
    const s2 = await game.getState(comp.code, comp.players[0].id);
    await game.submitGuess(comp.code, s2.currentPlayerId, room2.secret);
    await game.newRound(comp.code, comp.players[0].id);
    await game.endRound(comp.code, room2.creatorId);
    await game.removePlayer(comp.code, room2.creatorId, comp.players[1].id);

    const expiring = keysExpiredWithTTL(fake.log);
    const mutated = mutatedKeys(fake.log);

    const missing = [...mutated].filter((k) => !expiring.has(k));
    T.assert(missing.length === 0, `these keys were written but never given a ${TTL}s expiry: ${missing.join(", ")}`);

    // Spot-check the key patterns we expect to have seen.
    const patterns = [
      /^room:[A-Z0-9]{5}$/,
      /^room:[A-Z0-9]{5}:players$/,
      /^room:[A-Z0-9]{5}:order$/,
      /^room:[A-Z0-9]{5}:turn$/,
      /^room:[A-Z0-9]{5}:names$/,
      /^room:[A-Z0-9]{5}:scores$/,
      /^room:[A-Z0-9]{5}:turnclaim:\d+:[^:]+:\d+$/,
      /^room:[A-Z0-9]{5}:winner:\d+$/,
      /^room:[A-Z0-9]{5}:roundstart:\d+$/,
    ];
    for (const pattern of patterns) {
      const found = [...mutated].some((k) => pattern.test(k));
      T.assert(found, `expected at least one mutated key matching ${pattern}, but found none among: ${[...mutated].join(", ")}`);
    }
    for (const pattern of patterns) {
      const found = [...expiring].some((k) => pattern.test(k));
      T.assert(found, `expected at least one key matching ${pattern} to have a logged 24h expiry`);
    }
  });
}
