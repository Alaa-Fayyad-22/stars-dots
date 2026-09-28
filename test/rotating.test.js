import {
  createGameWithPlayers, rawRoom, setRawPlayer, randomValidNumber,
} from "./helpers.js";

export default async function run({ game, fake, T }) {
  T.suite("Rotating mode specifics");

  await T.test("host is excluded from turn order and can't guess", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    const secret = randomValidNumber(4);
    await game.pickSecret(code, room.hostId, secret);
    const state = await game.getState(code, room.hostId);
    T.assert(state.currentPlayerId !== room.hostId, "host should never be the current turn player");
    const attempt = await game.submitGuess(code, room.hostId, randomValidNumber(4, new Set([secret])));
    T.assert(!!attempt.error, "host guessing should be rejected");
  });

  await T.test("nobody can guess before the host picks a number", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 3 });
    const state = await game.getState(code, players[1].id);
    T.eq(state.roundState, "pending", "round should start pending");
    T.eq(state.currentPlayerId, null, "no current player while pending");
    const attempt = await game.submitGuess(code, players[1].id, randomValidNumber(4));
    T.assert(!!attempt.error, "guessing before the number is picked should be rejected");
  });

  await T.test("first turn goes to the first non-host player in join order", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 4 });
    const room = rawRoom(fake, code);
    await game.pickSecret(code, room.hostId, randomValidNumber(4));
    const state = await game.getState(code, players[0].id);
    const firstNonHost = players.find((p) => p.id !== room.hostId);
    T.eq(state.currentPlayerId, firstNonHost.id, "first turn should go to the first joined non-host player");
  });

  await T.test("host-only actions are rejected for everyone else", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    const nonHost = players.find((p) => p.id !== room.hostId);
    const pickByNonHost = await game.pickSecret(code, nonHost.id, randomValidNumber(4));
    T.assert(!!pickByNonHost.error, "a non-host picking the secret should be rejected");

    await game.pickSecret(code, room.hostId, randomValidNumber(4));
    const skipByNonHost = await game.skipTurn(code, nonHost.id);
    // Nobody has gone stale, so a non-host skip should be rejected.
    T.assert(!!skipByNonHost.error, "a non-host skipping a turn (without staleness) should be rejected");

    const removeByNonHost = await game.removePlayer(code, nonHost.id, players[players.length - 1].id);
    T.assert(!!removeByNonHost.error, "a non-host removing a player should be rejected");

    const endByNonHost = await game.endRound(code, nonHost.id);
    T.assert(!!endByNonHost.error, "a non-host ending the round should be rejected");
  });

  await T.test("end round with no winner passes hosting to the next player in join order", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 3 });
    const room1 = rawRoom(fake, code);
    const hostIdx = players.findIndex((p) => p.id === room1.hostId);
    await game.pickSecret(code, room1.hostId, randomValidNumber(4));
    const out = await game.endRound(code, room1.hostId);
    T.assert(!out.error, `endRound should succeed, got: ${out.error}`);

    const room2 = rawRoom(fake, code);
    T.eq(room2.round, room1.round + 1, "round should increment after ending with no winner");
    T.eq(room2.roundState, "pending", "next round should be pending");
    const expectedNextHost = players[(hostIdx + 1) % players.length].id;
    T.eq(room2.hostId, expectedNextHost, "hosting should pass to the next player in join order");

    const state = await game.getState(code, players[0].id);
    T.eq(state.winner, null, "no winner should be recorded");
    const scoreboard = state.scoreboard;
    T.assert(scoreboard.every((e) => e.wins === 0), "nobody should score from a no-winner round");
  });

  await T.test("stuck-host fallback only works after 60s of inactivity, during pending only", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 3 });
    const room = rawRoom(fake, code);

    const tooSoon = await game.makeNextHost(code, players.find((p) => p.id !== room.hostId).id);
    T.assert(!!tooSoon.error, "make-next-host should fail before the host has gone stale");

    setRawPlayer(fake, code, room.hostId, { lastSeen: Date.now() - 61_000 });
    const requester = players.find((p) => p.id !== room.hostId);
    const now = await game.makeNextHost(code, requester.id);
    T.assert(!now.error, `make-next-host should succeed once the host is stale, got: ${now.error}`);

    const room2 = rawRoom(fake, code);
    T.assert(room2.hostId !== room.hostId, "hosting should have moved to someone else");
    T.eq(room2.roundState, "pending", "still pending, waiting for the new host to pick");

    // Once a number is picked, make-next-host is no longer relevant.
    await game.pickSecret(code, room2.hostId, randomValidNumber(4));
    setRawPlayer(fake, code, room2.hostId, { lastSeen: Date.now() - 61_000 });
    const afterActive = await game.makeNextHost(code, players[0].id);
    T.assert(!!afterActive.error, "make-next-host should be rejected once the round is active");
  });

  await T.test("winner becomes host of the next round", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 3 });
    const room1 = rawRoom(fake, code);
    const secret = randomValidNumber(4);
    await game.pickSecret(code, room1.hostId, secret);
    const state = await game.getState(code, players[0].id);
    const winnerId = state.currentPlayerId;
    const r = await game.submitGuess(code, winnerId, secret);
    T.assert(r.won, "should win with the actual secret");
    const room2 = rawRoom(fake, code);
    T.eq(room2.hostId, winnerId, "the winner should become the next host");
    T.eq(room2.roundState, "pending", "the next round should be pending");
  });

  await T.test("removing the current host reassigns hosting without crashing", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 4 });
    const room = rawRoom(fake, code);
    // The host removes themself — removePlayer() requires the requester to
    // BE the host to remove anyone in rotating mode, including themselves.
    const out = await game.removePlayer(code, room.hostId, room.hostId);
    T.assert(!out.error, `host removing themself should succeed, got: ${out.error}`);
    const room2 = rawRoom(fake, code);
    T.assert(room2.hostId && room2.hostId !== room.hostId, "a new host should have been assigned");
    const state = await game.getState(code, room2.hostId);
    T.assert(state.roundState === "pending" || state.roundState === "active", "game should still be in a valid state");
  });
}
