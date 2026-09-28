import {
  createGameWithPlayers, playRoundToWin, advanceToNextRound, rawRoom,
  assertNoSecretLeak,
} from "./helpers.js";

// Every combination of mode x digits x player count, playing 3 full rounds
// each, checking turn order, star/dot correctness (via playRoundToWin's own
// independent reference check), round-ending, secret reveal timing, secret
// leakage at every stage, scoreboard updates, and next-round startup.
export default async function run({ game, fake, T }) {
  T.suite("Matrix: mode x digits x player count, 3 full rounds each");

  const modes = ["rotating", "computer"];
  const digitsList = [3, 4, 5];
  const counts = [2, 3, 4, 5];

  const results = [];

  for (const mode of modes) {
    for (const digits of digitsList) {
      for (const count of counts) {
        const label = `${mode} x ${digits} digits x ${count} players`;
        let ok = true;
        await T.test(label, async () => {
          const { code, players } = await createGameWithPlayers(game, { mode, digits, count });
          const wins = {}; // playerId -> {wins, triesSum}
          for (const p of players) wins[p.id] = { wins: 0, triesSum: 0 };

          for (let round = 1; round <= 3; round++) {
            await assertNoSecretLeak(T, game, fake, code, players);

            const before = rawRoom(fake, code);
            const { secret, digits: d, winnerId, roundJustWon } = await playRoundToWin(game, fake, code, players[0].id, T);
            T.eq(d, digits, "room digit count should stay fixed");
            T.eq(secret.length, digits, "secret should match the room's digit count");
            T.eq(new Set(secret).size, digits, "secret should use all-different digits");
            T.assert(secret[0] !== "0", "secret should not start with 0");
            T.eq(roundJustWon, before.round, "round number should match before playing it");

            wins[winnerId].wins += 1;
            // tries = length of the winner's history right after winning
            const stateNow = await game.getState(code, winnerId);
            wins[winnerId].triesSum += stateNow.me.history.length;

            // Secret reveal: everyone should now see it, and it should match.
            for (const p of players) {
              const s = await game.getState(code, p.id);
              T.eq(s.revealedSecret, secret, `${p.name} should see the revealed secret after a win`);
              T.eq(s.winner.id, winnerId, `${p.name} should see the correct winner id`);
              // The winning guess must still be visible in the feed.
              const winnerEntryInFeed = s.players.find((pp) => pp.id === winnerId);
              T.assert(winnerEntryInFeed.history.some((h) => h.guess === secret), "winning guess should remain visible in the feed right after the win");
            }
            await assertNoSecretLeak(T, game, fake, code, players);

            // Scoreboard reflects the win.
            const scState = await game.getState(code, players[0].id);
            const entry = scState.scoreboard.find((e) => e.id === winnerId);
            T.eq(entry.wins, wins[winnerId].wins, "scoreboard win count should match");
            const expectedAvg = wins[winnerId].triesSum / wins[winnerId].wins;
            T.assert(Math.abs(entry.avgTries - expectedAvg) < 1e-9, `scoreboard avgTries should be ${expectedAvg}, got ${entry.avgTries}`);

            if (round < 3) {
              await advanceToNextRound(game, fake, code, players[0].id);
              const after = rawRoom(fake, code);
              T.eq(after.round, before.round + 1, "round number should increment after starting the next round");
              // Once the new round is under way, the guess feed clears and
              // the old reveal disappears (never the new secret).
              for (const p of players) {
                const s = await game.getState(code, p.id);
                const winnerEntryInFeed = s.players.find((pp) => pp.id === winnerId);
                T.eq(winnerEntryInFeed.history.length, 0, `${p.name} should see a cleared history once the next round starts`);
                T.eq(s.revealedSecret, null, `${p.name} should not still see the old reveal once a new round is active`);
              }
              await assertNoSecretLeak(T, game, fake, code, players);
            }
          }
        });
      }
    }
  }

  return results;
}
