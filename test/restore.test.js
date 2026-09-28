import {
  createGameWithPlayers, rawRoom, rawOrder, rawPlayer, randomValidNumber, startRoundIfNeeded,
  advanceToNextRound,
} from "./helpers.js";

// Covers restorePlayer(): who's allowed to call it, which targets are
// eligible, and that it never disturbs whose turn it is or duplicates
// someone in the turn order.
export default async function run({ game, fake, T }) {
  T.suite("Restore a removed player");

  await T.test("only the controls holder can restore — a normal player, the removed player themselves, and a former host/organizer who left are all rejected", async () => {
    for (const mode of ["computer", "rotating"]) {
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: 4 });
      const room = rawRoom(fake, code);
      const holderId = room.controlsId;
      const normal = players.find((p) => p.id !== holderId);
      const target = players.find((p) => p.id !== holderId && p.id !== normal.id);

      const removed = await game.removePlayer(code, holderId, target.id);
      T.assert(!removed.error, `${mode}: remove should succeed, got: ${removed.error}`);

      const byNormal = await game.restorePlayer(code, normal.id, target.id);
      T.assert(!!byNormal.error, `${mode}: a normal (non-controls) player should not be able to restore`);

      const bySelf = await game.restorePlayer(code, target.id, target.id);
      T.assert(!!bySelf.error, `${mode}: the removed player should not be able to restore themselves`);

      const leftOut = await game.leaveGame(code, holderId);
      T.assert(!leftOut.error, `${mode}: controls holder leaveGame should succeed, got: ${leftOut.error}`);
      const byFormerHolder = await game.restorePlayer(code, holderId, target.id);
      T.assert(!!byFormerHolder.error, `${mode}: a former host/organizer who left should not be able to restore`);

      const roomAfter = rawRoom(fake, code);
      const byNewHolder = await game.restorePlayer(code, roomAfter.controlsId, target.id);
      T.assert(!byNewHolder.error, `${mode}: the current controls holder should be able to restore, got: ${byNewHolder.error}`);
      const targetAfter = rawPlayer(fake, code, target.id);
      T.assert(!targetAfter.removed, `${mode}: restored player should no longer be marked removed`);
    }
  });

  await T.test("players who left on their own can't be restored", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    const organizer = room.controlsId;
    const leaveOut = await game.leaveGame(code, organizer);
    T.assert(!leaveOut.error, `leaveGame should succeed, got: ${leaveOut.error}`);

    const roomAfter = rawRoom(fake, code);
    const restoreOut = await game.restorePlayer(code, roomAfter.controlsId, organizer);
    T.assert(!!restoreOut.error, "a player who left on their own should not be restorable");
    T.assert(/left on their own/i.test(restoreOut.error), `error should explain why, got: ${restoreOut.error}`);
  });

  await T.test("restoring a player who isn't removed is rejected", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    const target = players.find((p) => p.id !== room.controlsId);
    const out = await game.restorePlayer(code, room.controlsId, target.id);
    T.assert(!!out.error, "restoring an active (non-removed) player should be rejected");
    T.assert(/already in the game/i.test(out.error), `error should explain why, got: ${out.error}`);
  });

  await T.test("the turn doesn't change when someone is restored", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 4 });
    const room = rawRoom(fake, code);
    const organizer = room.controlsId;
    const target = players.find((p) => p.id !== organizer && p.id !== room.hostId);
    await game.removePlayer(code, organizer, target.id);

    const before = await game.getState(code, organizer);
    const beforeTurn = before.currentPlayerId;
    T.assert(!!beforeTurn, "there should be a current turn before restoring");
    T.assert(beforeTurn !== target.id, "sanity: the removed player shouldn't already hold the turn");

    const out = await game.restorePlayer(code, organizer, target.id);
    T.assert(!out.error, `restore should succeed, got: ${out.error}`);

    const after = await game.getState(code, organizer);
    T.eq(after.currentPlayerId, beforeTurn, "restoring a player should never change whose turn it is");
  });

  await T.test("the restored player gets their turn after everyone else currently in the game", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 4 });
    const room = rawRoom(fake, code);
    const organizer = room.controlsId;
    const target = players.find((p) => p.id !== organizer);
    await game.removePlayer(code, organizer, target.id);
    await game.restorePlayer(code, organizer, target.id);

    const order = rawOrder(fake, code);
    T.eq(order[order.length - 1], target.id, "restored player should be at the end of the turn order");

    // Step through a full cycle of turns and confirm the restored player is
    // the very last one to guess.
    const used = new Set();
    const turnSequence = [];
    for (let i = 0; i < order.length; i++) {
      const s = await game.getState(code, organizer);
      turnSequence.push(s.currentPlayerId);
      const g = randomValidNumber(4, used);
      used.add(g);
      const r = await game.submitGuess(code, s.currentPlayerId, g);
      T.assert(!r.error, `turn ${i}: guess should succeed, got: ${r.error}`);
    }
    T.eq(turnSequence[turnSequence.length - 1], target.id, "the restored player should be the last to get a turn in the cycle");
  });

  await T.test("history and score are intact after remove + restore in the same round", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    const organizer = room.controlsId;
    const target = players.find((p) => p.id !== organizer);

    // Give the target a guess (history) before removing them.
    let s = await game.getState(code, organizer);
    while (s.currentPlayerId !== target.id) {
      const g = randomValidNumber(4, new Set(s.players.flatMap((p) => p.history.map((h) => h.guess))));
      await game.submitGuess(code, s.currentPlayerId, g);
      s = await game.getState(code, organizer);
    }
    const guess = randomValidNumber(4, new Set(s.players.flatMap((p) => p.history.map((h) => h.guess))));
    await game.submitGuess(code, target.id, guess);
    const before = await game.getState(code, organizer);
    const beforeHistory = before.players.find((p) => p.id === target.id).history;
    T.eq(beforeHistory.length, 1, "sanity: target should have one guess on record");

    await game.removePlayer(code, organizer, target.id);
    await game.restorePlayer(code, organizer, target.id);

    const after = await game.getState(code, organizer);
    const afterEntry = after.players.find((p) => p.id === target.id);
    T.eq(afterEntry.history.length, beforeHistory.length, "history should be preserved across remove + restore");
    T.eq(afterEntry.history[0].guess, beforeHistory[0].guess, "the actual guess should be preserved");
    T.assert(!afterEntry.removed, "player should show as active after restore");
  });

  await T.test("restoring twice never puts the player in the turn order twice", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    const organizer = room.controlsId;
    const target = players.find((p) => p.id !== organizer);

    await game.removePlayer(code, organizer, target.id);
    const first = await game.restorePlayer(code, organizer, target.id);
    T.assert(!first.error, `first restore should succeed, got: ${first.error}`);
    const second = await game.restorePlayer(code, organizer, target.id);
    T.assert(!!second.error, "restoring an already-active player again should be rejected");

    const order = rawOrder(fake, code);
    const occurrences = order.filter((id) => id === target.id).length;
    T.eq(occurrences, 1, "the restored player should appear exactly once in the turn order");
  });

  await T.test("a restored player can rejoin with their PIN and shows up in the rejoin list again", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3, pin: "7777" });
    const room = rawRoom(fake, code);
    const organizer = room.controlsId;
    const target = players.find((p) => p.id !== organizer);

    await game.removePlayer(code, organizer, target.id);
    const midState = await game.getState(code, organizer);
    T.assert(midState.players.find((p) => p.id === target.id).removed, "target should be removed before restore");

    const rejoinWhileRemoved = await game.rejoinRoom(code, target.name, "7777");
    T.assert(!!rejoinWhileRemoved.error, "a removed player should not be able to rejoin before being restored");

    await game.restorePlayer(code, organizer, target.id);

    const afterState = await game.getState(code, organizer);
    const activeNames = afterState.players.filter((p) => !p.removed).map((p) => p.name);
    T.assert(activeNames.includes(target.name), "restored player should appear in the active/rejoin-eligible list again");

    const rejoinAfter = await game.rejoinRoom(code, target.name, "7777");
    T.assert(!rejoinAfter.error, `restored player should be able to rejoin with their PIN, got: ${rejoinAfter.error}`);
    T.eq(rejoinAfter.playerId, target.id, "rejoin should return the same player id");
  });

  await T.test("restoring in a later round works", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    const organizer = room.controlsId;
    const target = players.find((p) => p.id !== organizer);

    await game.removePlayer(code, organizer, target.id);

    // Finish round 1 without the removed player, then start round 2.
    let s = await game.getState(code, organizer);
    let guard = 0;
    while (s.roundState === "active" && guard++ < 20) {
      const used = new Set(s.players.flatMap((p) => p.history.map((h) => h.guess)));
      const room2 = rawRoom(fake, code);
      await game.submitGuess(code, s.currentPlayerId, room2.secret);
      s = await game.getState(code, organizer);
    }
    T.assert(s.roundState === "ended", "round 1 should have ended");
    await advanceToNextRound(game, fake, code, organizer);
    const roomRound2 = rawRoom(fake, code);
    T.eq(roomRound2.round, 2, "sanity: should now be round 2");

    const restoreOut = await game.restorePlayer(code, organizer, target.id);
    T.assert(!restoreOut.error, `restoring in round 2 should succeed, got: ${restoreOut.error}`);
    const after = await game.getState(code, organizer);
    T.assert(!after.players.find((p) => p.id === target.id).removed, "restored player should be active in round 2");
    const order = rawOrder(fake, code);
    T.assert(order.includes(target.id), "restored player should be back in the turn order in round 2");
  });
}
