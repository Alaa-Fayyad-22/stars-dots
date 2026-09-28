import {
  createGameWithPlayers, rawRoom, randomValidNumber, playRoundToWin, startRoundIfNeeded,
  advanceToNextRound,
} from "./helpers.js";

const TTL = 60 * 60 * 24;

// Covers recordRound(): the {round, secret, winnerName, totalTries} entries
// saved to room:{code}:rounds on both a won round and an "End round", across
// modes and digit counts, including removed players' guesses in the total,
// exactly-once recording under a race, and correct ordering relative to the
// round/secret state transition.
export default async function run({ game, fake, T }) {
  T.suite("Rounds table");

  for (const mode of ["rotating", "computer"]) {
    for (const digits of [3, 4, 5]) {
      await T.test(`${mode} x ${digits} digits: a won round is recorded with the right round/number/winner/tries`, async () => {
        const { code, players } = await createGameWithPlayers(game, { mode, digits, count: 3 });
        const before = rawRoom(fake, code);
        const { secret, winnerId, guesses } = await playRoundToWin(game, fake, code, players[0].id, T);

        const state = await game.getState(code, players[0].id);
        T.eq(state.rounds.length, 1, "one round should be recorded after a win");
        const entry = state.rounds[0];
        T.eq(entry.round, before.round, "recorded round number should be the round that was just won");
        T.eq(entry.secret, secret, "recorded secret should be the winning number");
        const winnerName = players.find((p) => p.id === winnerId).name;
        T.eq(entry.winnerName, winnerName, "recorded winner name should match");
        const expectedTries = guesses.length; // every guess this round, by everyone
        T.eq(entry.totalTries, expectedTries, "recorded total tries should be every guess made this round");
      });

      await T.test(`${mode} x ${digits} digits: "End round" is recorded with no winner and the right tries`, async () => {
        const { code, players } = await createGameWithPlayers(game, { mode, digits, count: 3 });
        await startRoundIfNeeded(game, fake, code);
        const before = rawRoom(fake, code);

        // A couple of decoy guesses before ending the round.
        const used = new Set([before.secret]);
        let tries = 0;
        for (let i = 0; i < 2; i++) {
          const s = await game.getState(code, players[0].id);
          if (!s.currentPlayerId) break;
          const g = randomValidNumber(digits, used);
          used.add(g);
          const r = await game.submitGuess(code, s.currentPlayerId, g);
          T.assert(!r.error, `decoy guess should succeed, got: ${r.error}`);
          tries++;
        }

        const holderId = before.controlsId;
        const out = await game.endRound(code, holderId);
        T.assert(!out.error, `endRound should succeed, got: ${out.error}`);

        const state = await game.getState(code, players[0].id);
        const entry = state.rounds.find((r) => r.round === before.round);
        T.assert(!!entry, "the ended round should be recorded");
        T.eq(entry.secret, before.secret, "recorded secret should be the round's actual number");
        T.eq(entry.winnerName, null, "an ended-with-no-winner round should record no winner");
        T.eq(entry.totalTries, tries, "recorded total tries should match the guesses made before ending");
      });
    }
  }

  await T.test("total tries includes a removed player's guesses from this round", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    const organizer = room.controlsId;
    const target = players.find((p) => p.id !== organizer);

    // Get the target to guess once, then remove them.
    let s = await game.getState(code, organizer);
    while (s.currentPlayerId !== target.id) {
      const g = randomValidNumber(4, new Set(s.players.flatMap((p) => p.history.map((h) => h.guess))));
      await game.submitGuess(code, s.currentPlayerId, g);
      s = await game.getState(code, organizer);
    }
    const targetGuess = randomValidNumber(4, new Set(s.players.flatMap((p) => p.history.map((h) => h.guess))));
    await game.submitGuess(code, target.id, targetGuess);
    await game.removePlayer(code, organizer, target.id);

    // Finish the round with whoever's left.
    let cur = await game.getState(code, organizer);
    let totalGuessesSoFar = cur.players.reduce((sum, p) => sum + p.history.length, 0);
    let guard = 0;
    while (cur.roundState === "active" && guard++ < 20) {
      const roomNow = rawRoom(fake, code);
      const r = await game.submitGuess(code, cur.currentPlayerId, roomNow.secret);
      T.assert(!r.error, `winning guess should succeed, got: ${r.error}`);
      cur = await game.getState(code, organizer);
    }
    totalGuessesSoFar = cur.players.reduce((sum, p) => sum + p.history.length, 0);

    const entry = cur.rounds.find((r) => r.round === 1);
    T.assert(!!entry, "round 1 should be recorded");
    T.eq(entry.totalTries, totalGuessesSoFar, "total tries should include the removed player's guess");
    T.assert(entry.totalTries >= 2, "sanity: total should include at least the removed player's guess plus the winning guess");
  });

  await T.test("the round is recorded exactly once even when two 'End round' requests race", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    const [r1, r2] = await Promise.all([
      game.endRound(code, room.controlsId),
      game.endRound(code, room.controlsId),
    ]);
    T.assert(!r1.error || !r2.error, "at least one of the two racing End round requests should succeed");

    const state = await game.getState(code, players[0].id);
    const entries = state.rounds.filter((r) => r.round === 1);
    T.eq(entries.length, 1, "a raced End round should still only record the round once");
  });

  await T.test("the round is recorded exactly once even when a winning guess is double-submitted (double-tap)", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 2 });
    const room = rawRoom(fake, code);
    const s = await game.getState(code, players[0].id);
    const [r1, r2] = await Promise.all([
      game.submitGuess(code, s.currentPlayerId, room.secret),
      game.submitGuess(code, s.currentPlayerId, room.secret),
    ]);
    const successes = [r1, r2].filter((r) => !r.error);
    T.eq(successes.length, 1, "only one of two identical concurrent winning submissions should succeed");

    const state = await game.getState(code, players[0].id);
    const entries = state.rounds.filter((r) => r.round === 1);
    T.eq(entries.length, 1, "a double-submitted winning guess should still only record the round once");
  });

  await T.test("recording happens before the secret is cleared and the round number changes", async () => {
    for (const mode of ["rotating", "computer"]) {
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: 3 });
      const before = rawRoom(fake, code);
      const { secret } = await playRoundToWin(game, fake, code, players[0].id, T);

      const state = await game.getState(code, players[0].id);
      const entry = state.rounds[0];
      T.eq(entry.round, before.round, "recorded round should be the pre-increment round number");
      T.eq(entry.secret, secret, "recorded secret should be the just-finished round's actual secret, not null/cleared");

      const roomAfter = rawRoom(fake, code);
      if (mode === "rotating") {
        T.eq(roomAfter.round, before.round + 1, "sanity: round should have advanced after the win");
        T.eq(roomAfter.secret, null, "sanity: the live secret should be cleared once the round moved on");
      }
    }
  });

  await T.test("the rounds key has a 24-hour expiry", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 2 });
    await playRoundToWin(game, fake, code, players[0].id, null);
    const roundsKeyName = `room:${code}:rounds`;
    const expireEntries = fake.log.filter((e) => e.key === roundsKeyName && (
      e.cmd === "expire" || (e.cmd === "set" && e.args.slice(2).map((v) => String(v).toLowerCase()).includes("ex"))
    ));
    T.assert(expireEntries.length > 0, "the rounds key should have at least one expiry set");
    for (const e of expireEntries) {
      if (e.cmd === "expire") {
        T.eq(Number(e.args[1]), TTL, `rounds key expire should be ${TTL}s, got ${e.args[1]}`);
      }
    }
  });

  await T.test("the secret in the rounds list only ever belongs to a finished round, never the currently-active one", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 2 });
    // Mid-round, before anyone has won: no entry should exist yet for the
    // active round.
    const mid = await game.getState(code, players[0].id);
    T.eq(mid.roundState, "active", "sanity: round should be active");
    T.assert(!mid.rounds.some((r) => r.round === mid.round), "an active round should not already appear in the rounds list");

    await playRoundToWin(game, fake, code, players[0].id, null);
    await advanceToNextRound(game, fake, code, players[0].id);

    const afterNextRoundStarted = await game.getState(code, players[0].id);
    T.eq(afterNextRoundStarted.roundState, "active", "sanity: round 2 should now be active");
    T.assert(
      !afterNextRoundStarted.rounds.some((r) => r.round === afterNextRoundStarted.round),
      "the now-active round should still not appear in the rounds list"
    );
    T.assert(
      afterNextRoundStarted.rounds.every((r) => r.round < afterNextRoundStarted.round),
      "every recorded round should be strictly before the current active round"
    );
  });
}
