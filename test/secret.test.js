import { createGameWithPlayers, rawRoom, randomValidNumber, assertNoSecretLeak } from "./helpers.js";

// Covers getState()'s `secret` field: only the rotating host, only during
// their own active round, ever receives it — not before they pick it, not
// during a hostless round, and never in computer mode (organizer included).
export default async function run({ game, fake, T }) {
  T.suite("Secret visibility");

  await T.test("rotating: nobody sees the secret while it's pending (before the host picks one)", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    T.eq(room.roundState, "pending", "sanity: round should start pending");
    for (const p of players) {
      const s = await game.getState(code, p.id);
      T.eq(s.secret, null, `${p.name} should not see a secret before the host picks one`);
    }
  });

  await T.test("rotating: only the host sees the secret, and only during their own active round", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 4 });
    const room = rawRoom(fake, code);
    const secret = randomValidNumber(4);
    await game.pickSecret(code, room.hostId, secret);

    for (const p of players) {
      const s = await game.getState(code, p.id);
      if (p.id === room.hostId) {
        T.eq(s.secret, secret, "the host should see their own secret during their active round");
      } else {
        T.eq(s.secret, null, `${p.name} should never see the host's secret`);
      }
    }

    // An anonymous/unjoined viewer never sees it either.
    const anon = await game.getState(code, "not-a-real-player-id");
    T.eq(anon.secret, null, "an unjoined viewer should never see the secret");
  });

  await T.test("rotating: once the round ends, the (former) host no longer sees the live `secret` field", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    const secret = randomValidNumber(4);
    await game.pickSecret(code, room.hostId, secret);
    const hostId = room.hostId;

    await game.endRound(code, room.controlsId);

    const afterHost = await game.getState(code, hostId);
    T.eq(afterHost.secret, null, "the secret field should be null once the round has ended, even for the former host");
    // The reveal is the separate, intentional public channel for this.
    T.eq(afterHost.revealedSecret, secret, "the ended round's secret should instead be visible via revealedSecret");
  });

  await T.test("rotating: a hostless round (the host left mid-round) leaks the secret to nobody, including the controls holder", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 4 });
    const room = rawRoom(fake, code);
    const secret = randomValidNumber(4);
    await game.pickSecret(code, room.hostId, secret);
    const hostId = room.hostId;

    const out = await game.leaveGame(code, hostId);
    T.assert(!out.error, `host leaveGame should succeed, got: ${out.error}`);
    const roomAfter = rawRoom(fake, code);
    T.eq(roomAfter.hostId, null, "sanity: the round should now be hostless");
    T.eq(roomAfter.secret, secret, "sanity: the secret itself should still be set internally, just unheld");

    const remainingPlayers = players.filter((p) => p.id !== hostId);
    for (const p of remainingPlayers) {
      const s = await game.getState(code, p.id);
      T.eq(s.secret, null, `${p.name} should not see the secret during a hostless round, even the controls holder`);
    }
    await assertNoSecretLeak(T, game, fake, code, remainingPlayers);
  });

  await T.test("computer mode: nobody ever sees a secret, including the organizer, at any point in the round", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 4 });
    const room = rawRoom(fake, code);
    T.assert(!!room.secret, "sanity: the room does have a live secret internally");

    for (const p of players) {
      const s = await game.getState(code, p.id);
      T.eq(s.secret, null, `${p.name} should never see the secret in computer mode`);
    }

    // Guess a couple of times, removing/changing who the organizer is, and
    // re-check throughout the round.
    const s1 = await game.getState(code, players[0].id);
    await game.submitGuess(code, s1.currentPlayerId, randomValidNumber(4, new Set([room.secret])));
    for (const p of players) {
      const s = await game.getState(code, p.id);
      T.eq(s.secret, null, `${p.name} should still never see the secret mid-round`);
    }

    const out = await game.leaveGame(code, room.controlsId);
    T.assert(!out.error, `organizer leaveGame should succeed, got: ${out.error}`);
    const roomAfter = rawRoom(fake, code);
    const newOrganizerState = await game.getState(code, roomAfter.controlsId);
    T.eq(newOrganizerState.secret, null, "the new organizer should not see the secret either");
  });

  await T.test("computer mode: the secret is never sent even right up to the winning guess", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 3, count: 2 });
    const room = rawRoom(fake, code);
    const s = await game.getState(code, players[0].id);
    T.eq(s.secret, null, "no secret before winning");
    const result = await game.submitGuess(code, s.currentPlayerId, room.secret);
    T.assert(result.won, "sanity: that guess should have won");
    const afterWin = await game.getState(code, s.currentPlayerId);
    T.eq(afterWin.secret, null, "computer mode should never populate `secret`, even for the winner");
    T.eq(afterWin.revealedSecret, room.secret, "the winning round's secret should be visible via revealedSecret instead");
  });
}
