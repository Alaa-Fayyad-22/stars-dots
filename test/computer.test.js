import {
  createGameWithPlayers, rawRoom, setRawPlayer, randomValidNumber,
} from "./helpers.js";

export default async function run({ game, fake, T }) {
  T.suite("Computer mode specifics");

  await T.test("secret is valid for the chosen length, for every length", async () => {
    for (const digits of [3, 4, 5]) {
      const { code } = await createGameWithPlayers(game, { mode: "computer", digits, count: 2 });
      const room = rawRoom(fake, code);
      T.eq(room.secret.length, digits, `secret should be ${digits} digits long`);
      T.eq(new Set(room.secret).size, digits, "secret digits should all be different");
      T.assert(room.secret[0] !== "0", "secret should not start with 0");
    }
  });

  await T.test("organizer plays like everyone else and never receives the secret", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const organizer = players[0];
    const state = await game.getState(code, organizer.id);
    T.assert(state.isOrganizer, "creator should be flagged as organizer");
    T.eq(state.secret, null, "organizer should never see the secret");
    // Organizer is a normal part of the turn order.
    const order = state.players.map((p) => p.id);
    T.assert(order.includes(organizer.id), "organizer should be listed as a normal player");
  });

  await T.test("two simultaneous 'Next round' presses only start one round", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const room1 = rawRoom(fake, code);
    const secret = room1.secret;
    // Win the round so it's in 'ended' state.
    let state = await game.getState(code, players[0].id);
    let r = await game.submitGuess(code, state.currentPlayerId, secret);
    T.assert(r.won, "setup guess should win");
    const roundAfterWin = rawRoom(fake, code).round;

    const [a, b] = await Promise.all([
      game.newRound(code, players[0].id),
      game.newRound(code, players[1].id),
    ]);
    T.assert(!a.error && !b.error, "both concurrent newRound calls should resolve without error");
    const room2 = rawRoom(fake, code);
    T.eq(room2.round, roundAfterWin + 1, "round number should have advanced by exactly one, not two");
  });

  await T.test("inactive current player can be skipped by anyone after 60s", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const state = await game.getState(code, players[0].id);
    const curId = state.currentPlayerId;
    const other = players.find((p) => p.id !== curId);

    const tooSoon = await game.skipTurn(code, other.id);
    T.assert(!!tooSoon.error, "skip should fail before the current player has gone stale");

    setRawPlayer(fake, code, curId, { lastSeen: Date.now() - 61_000 });
    const now = await game.skipTurn(code, other.id);
    T.assert(!now.error, `skip should succeed once the current player is stale, got: ${now.error}`);

    const state2 = await game.getState(code, players[0].id);
    T.assert(state2.currentPlayerId !== curId, "turn should have moved on from the stale player");
  });

  await T.test("newRound is rejected in rotating mode", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 2 });
    const out = await game.newRound(code, players[0].id);
    T.assert(!!out.error, "newRound should be rejected in rotating mode");
  });

  await T.test("newRound is rejected while the round is still active", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 2 });
    const out = await game.newRound(code, players[0].id);
    T.assert(!!out.error, "newRound should be rejected while the round hasn't ended");
  });

  await T.test("organizer can end the round with no winner; nobody scores", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    const nonOrganizer = players.find((p) => p.id !== room.creatorId);
    const rejected = await game.endRound(code, nonOrganizer.id);
    T.assert(!!rejected.error, "a non-organizer ending the round should be rejected");

    const out = await game.endRound(code, room.creatorId);
    T.assert(!out.error, `organizer ending the round should succeed, got: ${out.error}`);
    const state = await game.getState(code, players[0].id);
    T.eq(state.roundState, "ended", "round should be ended");
    T.eq(state.winner, null, "no winner should be recorded");
    T.eq(state.revealedSecret, room.secret, "the secret should be revealed to everyone");
    T.assert(state.scoreboard.every((e) => e.wins === 0), "nobody should score from a no-winner round");
  });
}
