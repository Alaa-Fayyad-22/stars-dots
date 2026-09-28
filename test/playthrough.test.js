import {
  createGameWithPlayers, rawRoom, rawOrder, randomValidNumber, refCheckGuess,
  assertNoSecretLeak, startRoundIfNeeded, advanceToNextRound,
} from "./helpers.js";

// Full mixed-event games across player counts (2/4/6), digit counts
// (3/4/5), and both modes, at least 3 rounds each — weaving together late
// joiners, skip turn, remove + restore (including the player currently on
// turn), the host/organizer leaving mid-round and between rounds, "End
// round", rejoining with a PIN, and duplicate guesses. At every step: the
// screen (getState) and the server (submitGuess) must agree on whose turn
// it is, the rotating host must never be in the turn order, star/dot
// results must be correct, nobody may see a secret they shouldn't, and the
// scoreboard + rounds table must stay correct.
export default async function run({ game, fake, T }) {
  T.suite("Full mixed-event games with restore (2/4/6 players x 3/4/5 digits x both modes)");

  for (const mode of ["rotating", "computer"]) {
    for (const digits of [3, 4, 5]) {
      for (const count of [2, 4, 6]) {
        const label = `${mode} x ${digits} digits x ${count} players`;

        await T.test(label, async () => {
          const { code, players: initial } = await createGameWithPlayers(game, { mode, digits, count });
          const players = initial.map((p) => ({ ...p, status: "active" }));
          let extraJoinN = 0;
          const ROUNDS = 3;

          const activePlayers = () => players.filter((p) => p.status === "active");
          const nameOf = (id) => players.find((p) => p.id === id)?.name;

          // getState + submitGuess must agree on whose turn it is; the
          // rotating host must never hold it; star/dots must check out.
          async function verifyTurnAgreement(tag) {
            const room = rawRoom(fake, code);
            if (room.roundState !== "active") return null;
            const state = await game.getState(code, room.controlsId);
            const cur = state.currentPlayerId;
            if (!cur) return null;
            if (mode === "rotating") {
              T.assert(room.hostId !== cur, `${label} (${tag}): the rotating host should never hold the turn`);
            }
            const usedNow = new Set(state.players.flatMap((p) => p.history.map((h) => h.guess)));
            usedNow.add(room.secret);

            const impostor = activePlayers().find((p) => p.id !== cur && p.id !== room.hostId);
            if (impostor) {
              const badGuess = randomValidNumber(digits, usedNow);
              const bad = await game.submitGuess(code, impostor.id, badGuess);
              T.assert(!!bad.error, `${label} (${tag}): a player out of turn should be rejected`);
            }

            const g = randomValidNumber(digits, usedNow);
            const r = await game.submitGuess(code, cur, g);
            T.assert(!r.error, `${label} (${tag}): getState said it's ${nameOf(cur)}'s turn, but submitGuess rejected: ${r.error}`);
            if (r.result) {
              const ref = refCheckGuess(room.secret, g);
              T.eq(r.result.stars, ref.stars, `${label} (${tag}): star count should match the reference implementation`);
              T.eq(r.result.dots, ref.dots, `${label} (${tag}): dot count should match the reference implementation`);
            }
            return r;
          }

          for (let round = 1; round <= ROUNDS; round++) {
            if (mode === "rotating") await startRoundIfNeeded(game, fake, code);
            const beforeRoom = rawRoom(fake, code);

            // --- Late joiner ---
            extraJoinN++;
            const j = await game.joinRoom(code, `Late${round}_${extraJoinN}`, "1111");
            if (!j.error) players.push({ id: j.playerId, name: `Late${round}_${extraJoinN}`, status: "active" });

            await verifyTurnAgreement(`round ${round} early`);
            await assertNoSecretLeak(T, game, fake, code, activePlayers());

            // --- Skip turn ---
            const roomForSkip = rawRoom(fake, code);
            if (roomForSkip.roundState === "active") {
              const nonControls = activePlayers().find((p) => p.id !== roomForSkip.controlsId);
              if (nonControls) {
                const rejected = await game.skipTurn(code, nonControls.id);
                T.assert(!!rejected.error, `${label}: a non-controls-holder should not be able to skip`);
              }
              const skipped = await game.skipTurn(code, roomForSkip.controlsId);
              T.assert(!skipped.error, `${label}: controls-holder skip should succeed, got: ${skipped.error}`);
            }

            // --- Duplicate guess: rejected, and doesn't consume the turn ---
            const dupState = await game.getState(code, roomForSkip.controlsId);
            if (dupState.roundState === "active" && dupState.currentPlayerId) {
              const priorGuesses = dupState.players.flatMap((p) => p.history.map((h) => h.guess));
              if (priorGuesses.length) {
                const dup = await game.submitGuess(code, dupState.currentPlayerId, priorGuesses[0]);
                T.assert(!!dup.error, `${label}: a duplicate guess should be rejected`);
                const stillState = await game.getState(code, roomForSkip.controlsId);
                T.eq(stillState.currentPlayerId, dupState.currentPlayerId, `${label}: a rejected duplicate guess should not consume the turn`);
              }
            }

            // --- Remove + restore the player currently on turn ---
            const roomForCur = rawRoom(fake, code);
            if (roomForCur.roundState === "active") {
              const stateForCur = await game.getState(code, roomForCur.controlsId);
              const curId = stateForCur.currentPlayerId;
              // Skip if there's no current turn, or the current player *is*
              // the controls holder (removePlayer forbids targeting yourself
              // via that path — "Leave game" exists for that instead).
              if (curId && curId !== roomForCur.controlsId) {
                const usedBefore = new Set(stateForCur.players.flatMap((p) => p.history.map((h) => h.guess)));
                usedBefore.add(roomForCur.secret);
                const preGuess = randomValidNumber(digits, usedBefore);
                const preResult = await game.submitGuess(code, curId, preGuess);
                T.assert(!preResult.error, `${label}: current player's guess before removal should succeed, got: ${preResult.error}`);
                const beforeHistoryLen = (await game.getState(code, curId)).me.history.length;

                const controlsNow = rawRoom(fake, code).controlsId;
                const rm = await game.removePlayer(code, controlsNow, curId);
                T.assert(!rm.error, `${label}: removing the current player should succeed, got: ${rm.error}`);
                const afterRemove = await game.getState(code, controlsNow);
                const turnAfterRemove = afterRemove.currentPlayerId;

                const controlsNow2 = rawRoom(fake, code).controlsId;
                const rs = await game.restorePlayer(code, controlsNow2, curId);
                T.assert(!rs.error, `${label}: restoring the current player should succeed, got: ${rs.error}`);

                const afterRestore = await game.getState(code, controlsNow2);
                if (afterRestore.roundState === "active") {
                  if (turnAfterRemove) {
                    T.eq(afterRestore.currentPlayerId, turnAfterRemove, `${label}: restoring a player should never change whose turn it is`);
                  } else {
                    // Removing them left nobody to guess (e.g. rotating with
                    // only one non-host player) — restoring should hand the
                    // turn straight to them rather than leave it stuck.
                    T.eq(afterRestore.currentPlayerId, curId, `${label}: restoring the only remaining player should unstick the round onto them`);
                  }
                }
                const restoredEntry = afterRestore.players.find((p) => p.id === curId);
                T.assert(!restoredEntry.removed, `${label}: restored player should be active again`);
                T.eq(restoredEntry.history.length, beforeHistoryLen, `${label}: restored player's history should be intact`);
                const order = rawOrder(fake, code);
                T.eq(order.filter((id) => id === curId).length, 1, `${label}: restored player should appear exactly once in the turn order`);
              }
            }
            await assertNoSecretLeak(T, game, fake, code, activePlayers());

            // --- Rotating: host leaves mid-round on odd rounds -> hostless ---
            if (mode === "rotating" && round % 2 === 1) {
              const roomBefore = rawRoom(fake, code);
              if (roomBefore.roundState === "active" && roomBefore.hostId) {
                const out = await game.leaveGame(code, roomBefore.hostId);
                T.assert(!out.error, `${label}: host leaveGame should succeed, got: ${out.error}`);
                const departed = players.find((p) => p.id === roomBefore.hostId);
                if (departed) departed.status = "left";
                const roomAfter = rawRoom(fake, code);
                T.eq(roomAfter.hostId, null, `${label}: the round should now be hostless`);
                await assertNoSecretLeak(T, game, fake, code, activePlayers());
                await verifyTurnAgreement(`round ${round} hostless`);
              }
            }

            // --- Computer: the organizer leaves once, early on -> controls move on ---
            if (mode === "computer" && round === 1) {
              const roomBefore = rawRoom(fake, code);
              const out = await game.leaveGame(code, roomBefore.controlsId);
              T.assert(!out.error, `${label}: organizer leaveGame should succeed, got: ${out.error}`);
              const departed = players.find((p) => p.id === roomBefore.controlsId);
              if (departed) departed.status = "left";
              const roomAfter = rawRoom(fake, code);
              T.assert(!!roomAfter.controlsId && roomAfter.controlsId !== roomBefore.controlsId, `${label}: controls should move to someone else`);
              await verifyTurnAgreement(`round ${round} after organizer left`);
            }

            // --- Rejoin with PIN mid-round ---
            const rejoinTarget = activePlayers()[0];
            if (rejoinTarget) {
              const rj = await game.rejoinRoom(code, rejoinTarget.name, "1111");
              T.assert(!rj.error, `${label}: rejoin with the correct PIN should succeed, got: ${rj.error}`);
              T.eq(rj.playerId, rejoinTarget.id, `${label}: rejoin should return the exact same seat`);
            }

            // --- Finish the round: alternate winning it vs. "End round" ---
            const endThisRoundEarly = round % 2 === 0;
            let winnerId = null;
            const roomForFinish = rawRoom(fake, code);
            if (endThisRoundEarly) {
              const s = await game.getState(code, roomForFinish.controlsId);
              if (s.roundState === "active") {
                const out = await game.endRound(code, roomForFinish.controlsId);
                T.assert(!out.error, `${label}: End round should succeed, got: ${out.error}`);
              }
            } else {
              for (let i = 0; i < 60; i++) {
                const s = await game.getState(code, roomForFinish.controlsId);
                if (s.roundState !== "active" || !s.currentPlayerId) break;
                const room = rawRoom(fake, code);
                const g = await game.submitGuess(code, s.currentPlayerId, room.secret);
                T.assert(!g.error, `${label}: the winning guess should succeed, got: ${g.error}`);
                if (g.result) {
                  const ref = refCheckGuess(room.secret, room.secret);
                  T.eq(g.result.stars, ref.stars, `${label}: winning guess should have full stars`);
                }
                if (g.won) { winnerId = s.currentPlayerId; break; }
              }
              T.assert(!!winnerId, `${label}: someone should have won round ${round}`);
            }

            // --- Rounds table + scoreboard correctness ---
            const endedState = await game.getState(code, roomForFinish.controlsId);
            const recorded = endedState.rounds.find((r) => r.round === beforeRoom.round);
            T.assert(!!recorded, `${label}: round ${beforeRoom.round} should be recorded`);
            if (winnerId) {
              T.eq(recorded.winnerName, nameOf(winnerId), `${label}: recorded winner name should match`);
              const entry = endedState.scoreboard.find((e) => e.id === winnerId);
              T.assert(!!entry && entry.wins >= 1, `${label}: the winner should have at least one recorded win`);
            } else if (endThisRoundEarly) {
              T.eq(recorded.winnerName, null, `${label}: an "End round" should record no winner`);
            }
            const expectedTries = endedState.players.reduce((sum, p) => sum + p.history.length, 0);
            T.eq(recorded.totalTries, expectedTries, `${label}: recorded total tries should be every guess made this round, including removed players'`);

            await assertNoSecretLeak(T, game, fake, code, activePlayers());

            // --- Advance to the next round ---
            if (round < ROUNDS) {
              const controlsForAdvance = rawRoom(fake, code).controlsId;
              await advanceToNextRound(game, fake, code, controlsForAdvance);
              const afterAdvance = rawRoom(fake, code);
              T.eq(afterAdvance.round, beforeRoom.round + 1, `${label}: round number should increment after starting the next round`);
            }
          }
        });
      }
    }
  }
}
