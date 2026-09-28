import {
  createGameWithPlayers, rawRoom, randomValidNumber, refCheckGuess, assertNoSecretLeak,
} from "./helpers.js";

// A broader "full check" pass: permission enforcement from every angle, and
// long mixed-event playthroughs (6 players and 2 players) that interleave
// late joins — including during a hostless round and while the host is
// still picking — skips, removals, permission rejections, the host/
// organizer leaving (repeatedly, in both rotating and computer mode),
// hostless rounds, "End round", duplicate-guess rejection, and malformed
// guesses sent straight to the API layer, bypassing client-side validation.
export default async function run({ game, fake, T }) {
  T.suite("Full check: permission matrix + long mixed-event playthroughs");

  await T.test("permission matrix: a normal player, a removed player, and a left player are all rejected from every host/organizer action", async () => {
    for (const mode of ["rotating", "computer"]) {
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: 4 });
      const room = rawRoom(fake, code);
      if (mode === "rotating") await game.pickSecret(code, room.hostId, randomValidNumber(4));

      const normal = players.find((p) => p.id !== room.creatorId);
      const removedTarget = players.find((p) => p.id !== room.creatorId && p.id !== normal.id);
      await game.removePlayer(code, room.creatorId, removedTarget.id);

      // A second organizer/host-controlled game so we can produce a "left"
      // player without disturbing the one under test above.
      const game2 = await createGameWithPlayers(game, { mode, digits: 4, count: 3 });
      const room2 = rawRoom(fake, game2.code);
      if (mode === "rotating") await game.pickSecret(game2.code, room2.hostId, randomValidNumber(4));
      const leaver = game2.players.find((p) => p.id !== room2.creatorId);
      // leaver isn't controls-holder, so give them controls first via a
      // no-op path isn't available — instead just prove a random non-
      // controls player can't act at all, which is the common case tested
      // by `normal` above; here we specifically prove a *left* player (the
      // organizer/host themselves, after leaving) can't act either.
      await game.leaveGame(game2.code, room2.hostId ?? room2.creatorId);

      for (const [label, actorId, targetCode, targetRoom] of [
        ["a normal player", normal.id, code, room],
        ["a removed player", removedTarget.id, code, room],
        ["a left former host/organizer", room2.hostId ?? room2.creatorId, game2.code, room2],
      ]) {
        const skip = await game.skipTurn(targetCode, actorId);
        T.assert(!!skip.error, `${label} should not be able to skip a turn (${mode})`);

        const remove = await game.removePlayer(targetCode, actorId, players[0].id);
        T.assert(!!remove.error, `${label} should not be able to remove a player (${mode})`);

        const end = await game.endRound(targetCode, actorId);
        T.assert(!!end.error, `${label} should not be able to end the round (${mode})`);

        const leave = await game.leaveGame(targetCode, actorId);
        if (label === "a left former host/organizer") {
          T.assert(!!leave.error, `${label} should not be able to leave again (${mode})`);
        } else {
          T.assert(!!leave.error, `${label} should not be able to use Leave game — they never held controls (${mode})`);
        }
      }
    }
  });

  for (const [mode, digits, count, rounds] of [
    ["rotating", 4, 6, 5],
    ["computer", 5, 6, 5],
    ["rotating", 3, 2, 3],
    ["computer", 3, 2, 3],
  ]) {
    await T.test(`${mode} x ${digits} digits x ${count} players: mixed-event playthrough (${rounds} rounds)`, async () => {
      const { code, players: initialPlayers } = await createGameWithPlayers(game, { mode, digits, count });
      let players = [...initialPlayers];
      let extraJoinN = 0;

      async function checkTurnAgreement(label) {
        const room = rawRoom(fake, code);
        if (room.roundState !== "active") return;
        const active = players.filter((p) => !p.leftOrRemoved);
        for (const p of active) {
          const s = await game.getState(code, p.id);
          if (s.currentPlayerId === p.id) {
            const usedGuesses = new Set();
            for (const pl of s.players) for (const h of pl.history) usedGuesses.add(h.guess);
            const g = await game.submitGuess(code, p.id, randomValidNumber(digits, usedGuesses));
            T.assert(!g.error, `${label}: getState said it was ${p.name}'s turn, but submitGuess rejected: ${g.error}`);
            if (mode === "rotating") {
              const room2 = rawRoom(fake, code);
              T.assert(room2.hostId !== p.id, `${label}: the rotating host should never be able to guess`);
            }
            return g;
          }
        }
        return null;
      }

      for (let round = 1; round <= rounds; round++) {
        if (mode === "rotating") {
          const room = rawRoom(fake, code);
          if (room.roundState === "pending") {
            await game.pickSecret(code, room.hostId, randomValidNumber(digits));
          }
        }

        // Late joiner near the start of the round.
        extraJoinN++;
        const j1 = await game.joinRoom(code, `Late${round}a${extraJoinN}`, "5555");
        if (!j1.error) players.push({ id: j1.playerId, name: `Late${round}a${extraJoinN}` });

        // A couple of turns.
        await checkTurnAgreement(`round ${round} early`);
        await checkTurnAgreement(`round ${round} early2`);

        // Skip-turn and permission rejection.
        const room1 = rawRoom(fake, code);
        const controlsId = room1.controlsId;
        const nonControls = players.find((p) => p.id !== controlsId && !p.leftOrRemoved);
        if (nonControls) {
          const rejected = await game.skipTurn(code, nonControls.id);
          T.assert(!!rejected.error, `round ${round}: a non-controls-holder should not be able to skip`);
        }
        const skipOut = await game.skipTurn(code, controlsId);
        T.assert(!skipOut.error, `round ${round}: controls-holder skip should succeed, got: ${skipOut.error}`);

        // Remove the current player (never the controls-holder).
        const stateForRemove = await game.getState(code, controlsId);
        if (stateForRemove.currentPlayerId && stateForRemove.currentPlayerId !== controlsId) {
          const rm = await game.removePlayer(code, controlsId, stateForRemove.currentPlayerId);
          T.assert(!rm.error, `round ${round}: removing the current player should succeed, got: ${rm.error}`);
          const removedP = players.find((p) => p.id === stateForRemove.currentPlayerId);
          if (removedP) removedP.leftOrRemoved = true;
        }

        // Rotating mode: the host leaves mid-round on odd rounds, producing
        // a hostless round; a late joiner arrives specifically during that
        // hostless window.
        if (mode === "rotating" && round % 2 === 1) {
          const roomBefore = rawRoom(fake, code);
          if (roomBefore.roundState === "active" && roomBefore.hostId) {
            const selfRemove = await game.removePlayer(code, roomBefore.hostId, roomBefore.hostId);
            T.assert(!!selfRemove.error, `round ${round}: host self-removal via removePlayer must be rejected`);
            const leftOut = await game.leaveGame(code, roomBefore.hostId);
            T.assert(!leftOut.error, `round ${round}: host leaveGame should succeed, got: ${leftOut.error}`);
            const departed = players.find((p) => p.id === roomBefore.hostId);
            if (departed) departed.leftOrRemoved = true;

            const roomAfter = rawRoom(fake, code);
            T.eq(roomAfter.hostId, null, `round ${round}: the round should now be hostless`);
            await assertNoSecretLeak(T, game, fake, code, players.filter((p) => !p.leftOrRemoved));

            // Late joiner arriving specifically during the hostless round.
            extraJoinN++;
            const jHostless = await game.joinRoom(code, `Hostless${round}_${extraJoinN}`, "6666");
            if (!jHostless.error) players.push({ id: jHostless.playerId, name: `Hostless${round}_${extraJoinN}` });

            await checkTurnAgreement(`round ${round} hostless`);
          }
        }

        // Computer mode: the organizer leaves, repeatedly, a couple of
        // rounds in a row — controls should keep passing on and play
        // should keep working throughout.
        if (mode === "computer" && round <= 2) {
          const roomBefore = rawRoom(fake, code);
          const before = await game.getState(code, roomBefore.controlsId);
          const out = await game.leaveGame(code, roomBefore.controlsId);
          T.assert(!out.error, `round ${round}: organizer leaveGame should succeed, got: ${out.error}`);
          const departed = players.find((p) => p.id === roomBefore.controlsId);
          if (departed) departed.leftOrRemoved = true;
          const roomAfter = rawRoom(fake, code);
          T.assert(!!roomAfter.controlsId && roomAfter.controlsId !== roomBefore.controlsId, `round ${round}: controls should pass to someone else`);
          await checkTurnAgreement(`round ${round} after organizer left`);
        }

        // Duplicate guess rejected without using up the turn.
        const dupState = await game.getState(code, players[0].id);
        if (dupState.roundState === "active" && dupState.currentPlayerId) {
          const someHistory = dupState.players.flatMap((p) => p.history.map((h) => h.guess));
          if (someHistory.length) {
            const dupGuess = someHistory[0];
            const dupAttempt = await game.submitGuess(code, dupState.currentPlayerId, dupGuess);
            T.assert(!!dupAttempt.error, `round ${round}: a duplicate guess should be rejected`);
            const stillState = await game.getState(code, players[0].id);
            T.eq(stillState.currentPlayerId, dupState.currentPlayerId, `round ${round}: a rejected duplicate guess should not use up the turn`);
          }
        }

        // Validation at the API layer: wrong length, letters, repeats, and
        // leading 0 must all be rejected before ever touching the secret.
        const valState = await game.getState(code, players[0].id);
        if (valState.roundState === "active" && valState.currentPlayerId) {
          const cur = valState.currentPlayerId;
          const tooShort = await game.submitGuess(code, cur, "1".repeat(digits - 1));
          T.assert(!!tooShort.error, `round ${round}: too-short guess should be rejected`);
          const tooLong = await game.submitGuess(code, cur, "1234567890".slice(0, digits + 1));
          T.assert(!!tooLong.error, `round ${round}: too-long guess should be rejected`);
          const letters = await game.submitGuess(code, cur, "a".repeat(digits));
          T.assert(!!letters.error, `round ${round}: non-digit guess should be rejected`);
          const repeated = await game.submitGuess(code, cur, "1".repeat(digits));
          T.assert(!!repeated.error, `round ${round}: repeated-digit guess should be rejected`);
          const leadingZero = await game.submitGuess(code, cur, "0" + "1".repeat(digits - 1));
          T.assert(!!leadingZero.error, `round ${round}: leading-zero guess should be rejected`);
        }

        // Play the round out to a winner.
        let winnerId = null;
        for (let i = 0; i < 40; i++) {
          const s = await game.getState(code, players[0].id);
          if (s.roundState !== "active" || !s.currentPlayerId) break;
          const room = rawRoom(fake, code);
          const usedGuesses = new Set();
          for (const pl of s.players) for (const h of pl.history) usedGuesses.add(h.guess);
          const g = await game.submitGuess(code, s.currentPlayerId, room.secret);
          T.assert(!g.error, `round ${round}: winning guess should succeed, got: ${g.error}`);
          if (g.result) {
            const ref = refCheckGuess(room.secret, room.secret);
            T.eq(g.result.stars, ref.stars, `round ${round}: winning stars should match reference`);
          }
          if (g.won) { winnerId = s.currentPlayerId; break; }
        }
        T.assert(!!winnerId, `round ${round}: someone should have won`);

        // End round should be rejected once the round has already ended.
        const endAfterWin = await game.endRound(code, winnerId);
        T.assert(!!endAfterWin.error, `round ${round}: end round should be rejected once the round already ended`);

        if (mode === "computer") {
          const stillActive = players.find((p) => !p.leftOrRemoved);
          const nr = await game.newRound(code, stillActive.id);
          T.assert(!nr.error, `round ${round}: newRound should succeed, got: ${nr.error}`);
        }
      }

      await assertNoSecretLeak(T, game, fake, code, players.filter((p) => !p.leftOrRemoved));
    });
  }

  await T.test("left players can't rejoin their old seat (rotating host, computer organizer)", async () => {
    for (const mode of ["rotating", "computer"]) {
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: 3 });
      const room = rawRoom(fake, code);
      const holderId = mode === "rotating" ? room.hostId : room.creatorId;
      const holderName = players.find((p) => p.id === holderId).name;
      const out = await game.leaveGame(code, holderId);
      T.assert(!out.error, `${mode}: leave should succeed, got: ${out.error}`);
      const rejoinAttempt = await game.rejoinRoom(code, holderName, "1111");
      T.assert(!!rejoinAttempt.error, `${mode}: a player who left should not be able to rejoin`);
    }
  });
}
