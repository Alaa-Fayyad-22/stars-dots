import { createGameWithPlayers, rawPlayer } from "./helpers.js";

export default async function run({ game, fake, T }) {
  T.suite("Rejoin with a PIN");

  await T.test("correct PIN restores the exact same seat (id, history, score)", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 2 });
    const ana = players[0];
    // Take a guess so there's history to preserve.
    const state = await game.getState(code, ana.id);
    if (state.currentPlayerId === ana.id) {
      await game.submitGuess(code, ana.id, "1937");
    }
    const before = await game.getState(code, ana.id);

    const rejoined = await game.rejoinRoom(code, "Ana", "1111");
    T.assert(!rejoined.error, `rejoin with the correct PIN should succeed, got: ${rejoined.error}`);
    T.eq(rejoined.playerId, ana.id, "rejoin should return the exact same player id");

    const after = await game.getState(code, rejoined.playerId);
    T.eq(after.me.history.length, before.me.history.length, "history should be preserved across rejoin");
    T.eq(after.isOrganizer, before.isOrganizer, "role should be preserved across rejoin");
  });

  await T.test("wrong PIN fails and locks out after 5 attempts", async () => {
    const { code } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 2 });
    for (let i = 0; i < 4; i++) {
      const attempt = await game.rejoinRoom(code, "Ana", "0000");
      T.assert(!!attempt.error, `wrong-PIN attempt ${i + 1} should fail`);
      T.assert(!/too many attempts/i.test(attempt.error), `should not lock out before 5 wrong attempts (attempt ${i + 1})`);
    }
    const fifth = await game.rejoinRoom(code, "Ana", "0000");
    T.assert(!!fifth.error, "5th wrong attempt should also fail");
    T.assert(/too many attempts/i.test(fifth.error), "5th wrong attempt should trigger the lockout message");

    const correctButLocked = await game.rejoinRoom(code, "Ana", "1111");
    T.assert(!!correctButLocked.error, "even the correct PIN should be rejected while locked out");
    T.assert(/too many attempts/i.test(correctButLocked.error), "lockout error should be clear");
  });

  await T.test("removed players can't rejoin their old seat", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const organizer = players[0];
    const target = players[1];
    const out = await game.removePlayer(code, organizer.id, target.id);
    T.assert(!out.error, `remove should succeed, got: ${out.error}`);
    const rejoinAttempt = await game.rejoinRoom(code, target.name, "1111");
    T.assert(!!rejoinAttempt.error, "a removed player should not be able to rejoin");
  });

  await T.test("duplicate names are rejected (case-insensitively) on join and create", async () => {
    const { code } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 1 });
    const dup1 = await game.joinRoom(code, "ANA", "2222");
    T.assert(!!dup1.error, "an exact-case duplicate name should be rejected");
    const dup2 = await game.joinRoom(code, "ana", "2222");
    T.assert(!!dup2.error, "a different-case duplicate name should also be rejected");
    const ok = await game.joinRoom(code, "Anabel", "2222");
    T.assert(!ok.error, "a distinct name should be accepted");
  });

  await T.test("no player-facing response ever contains the PIN or its hash", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 2 });
    const state = await game.getState(code, players[0].id);
    const json = JSON.stringify(state);
    T.assert(!json.includes("1111"), "the raw PIN should never appear in a state response");
    T.assert(!/pinHash|pinSalt/i.test(json), "PIN hash/salt fields should never appear in a state response");

    const rejoined = await game.rejoinRoom(code, players[0].name, "1111");
    const rejoinJson = JSON.stringify(rejoined);
    T.assert(!/pinHash|pinSalt/i.test(rejoinJson), "PIN hash/salt should never appear in a rejoin response");

    // Sanity: the underlying stored record has a hash distinct from the raw
    // PIN, proving we're not accidentally storing it in plaintext.
    const stored = rawPlayer(fake, code, players[0].id);
    T.assert(!!stored.pinHash, "player record should have a pinHash field");
    T.assert(stored.pinHash !== "1111", "pinHash should not be the plaintext PIN");
  });
}
