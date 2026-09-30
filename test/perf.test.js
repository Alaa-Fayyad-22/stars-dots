import { createGameWithPlayers, rawRoom, startRoundIfNeeded } from "./helpers.js";

// Redis commands per request, measured before this work began (identical code
// paths, playerId-only identity): a state poll = 8, one non-winning guess = 11.
// Token checks read the player record that every request already loads, so
// these numbers must not move.
const BASELINE = { poll: 8, pollAnonymous: 7, guess: 11 };

export default async function run({ game, fake, T }) {
  T.suite("Performance: Redis commands per request");

  async function count(fn) {
    const start = fake.log.length;
    await fn();
    return fake.log.slice(start).length;
  }

  for (const mode of ["rotating", "computer"]) {
    await T.test(`${mode}: a state poll is ${BASELINE.poll} commands and a guess is ${BASELINE.guess}, exactly as before`, async () => {
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: 4 });
      await startRoundIfNeeded(game, fake, code);
      const room = rawRoom(fake, code);
      await game.getState(code, players[0].id); // settle any self-repair writes
      const viewer = players.find((p) => p.id !== room.hostId);
      T.eq(await count(() => game.getState(code, viewer.id)), BASELINE.poll, "poll");
      T.eq(await count(() => game.getState(code, room.hostId || room.controlsId)), BASELINE.poll, "host/controls poll");
      T.eq(await count(() => game.getState(code, { id: "nobody", token: "x" })), BASELINE.pollAnonymous, "anonymous poll");
      const cur = (await game.getState(code, viewer.id)).currentPlayerId;
      const secret = room.secret;
      const guess = secret === "1234" ? "5678" : "1234";
      T.eq(await count(() => game.submitGuess(code, cur, guess)), BASELINE.guess, "guess");
      // Token checks never touch a key of their own.
      const tokenKeys = fake.log.filter((c) => /token/i.test(String(c.key)));
      T.eq(tokenKeys.length, 0, "no command ever touches a token key");
    });
  }
}
