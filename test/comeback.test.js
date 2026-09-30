import {
  createGameWithPlayers, rawRoom, rawOrder, rawPlayer, randomValidNumber, startRoundIfNeeded, playRoundToWin,
} from "./helpers.js";

const MODES = ["rotating", "computer"];

async function startRound(game, fake, code) {
  await startRoundIfNeeded(game, fake, code);
}

// One wrong guess by whoever's turn it is (returns their id).
async function wrongGuess(game, fake, code, viewer) {
  const s = await game.getState(code, viewer);
  const used = new Set(s.players.flatMap((p) => p.history.map((h) => h.guess)));
  const room = rawRoom(fake, code);
  used.add(room.secret);
  const out = await game.submitGuess(code, s.currentPlayerId, randomValidNumber(room.digits, used));
  if (out.error) throw new Error(`wrong guess failed: ${out.error}`);
  return s.currentPlayerId;
}

const noDupes = (list) => new Set(list).size === list.length;

export default async function run({ game, fake, T }) {
  T.suite("Leaving and coming back");

  for (const mode of MODES) {
    await T.test(`${mode}: a normal player leaving ON their turn passes the turn on at once; guesses stay, score is kept`, async () => {
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: 4 });
      await startRound(game, fake, code);
      // Round 1: someone wins, so there's a score to keep.
      const { winnerId } = await playRoundToWin(game, fake, code, players[0].id, T);
      const stateA = await game.getState(code, players[0].id);
      const winsBefore = stateA.scoreboard.find((e) => e.id === winnerId).wins;
      T.eq(winsBefore, 1, "someone has a score");
      if (mode === "computer") await game.newRound(code, players[0].id);
      else await startRound(game, fake, code);

      const first = await wrongGuess(game, fake, code, players[0].id);
      const s = await game.getState(code, players[0].id);
      const leaver = s.currentPlayerId;
      T.assert(leaver && leaver !== first, "someone else is up");
      const orderBefore = rawOrder(fake, code);
      const turnOrder = mode === "rotating" ? orderBefore.filter((id) => id !== rawRoom(fake, code).hostId) : orderBefore;
      const expectNext = turnOrder[(turnOrder.indexOf(leaver) + 1) % turnOrder.length];
      const out = await game.leaveGame(code, leaver);
      T.assert(!out.error, `leave: ${out.error}`);
      const after = await game.getState(code, first);
      T.eq(after.currentPlayerId, expectNext, "the turn passes to the next player immediately");
      T.assert(!rawOrder(fake, code).includes(leaver), "the leaver is out of the turn order");
      const row = after.players.find((p) => p.id === leaver);
      T.eq(row.leaveReason, "left", "marked as away");
      T.eq(after.scoreboard.find((e) => e.id === winnerId).wins, 1, "scores are kept");
      T.assert(after.players.find((p) => p.id === first).history.length === 1, "everyone's guesses stay visible");
    });

    await T.test(`${mode}: a normal player leaving when it is NOT their turn changes nobody's turn`, async () => {
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: 5 });
      await startRound(game, fake, code);
      const s = await game.getState(code, players[0].id);
      const room = rawRoom(fake, code);
      const notCurrent = players.find((p) => p.id !== s.currentPlayerId && p.id !== room.hostId && p.id !== room.controlsId);
      const out = await game.leaveGame(code, notCurrent.id);
      T.assert(!out.error, `leave: ${out.error}`);
      T.eq((await game.getState(code, s.currentPlayerId)).currentPlayerId, s.currentPlayerId, "same player's turn");
    });

    await T.test(`${mode}: leaving, coming back with the token — normal player again, end of the turn order, no duplicates`, async () => {
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: 4 });
      await startRound(game, fake, code);
      const room = rawRoom(fake, code);
      const P = players.find((p) => p.id !== room.hostId && p.id !== room.controlsId);
      for (let i = 0; i < 6; i++) {
        T.assert(!(await game.leaveGame(code, P.id)).error, `leave #${i + 1}`);
        const away = rawOrder(fake, code);
        T.assert(!away.includes(P.id) && noDupes(away), "out of the order, no dupes");
        T.assert(!(await game.comeBack(code, P.id)).error, `come back #${i + 1}`);
        const back = rawOrder(fake, code);
        T.eq(back.at(-1), P.id, "added at the END of the turn order");
        T.assert(noDupes(back), "no duplicate entries");
        T.eq(back.filter((id) => id === P.id).length, 1, "exactly once");
        const s = await game.getState(code, P.id);
        T.assert(s.me && !s.me.removed, "a normal player again");
        T.assert(!s.isHost && !s.isControlsHolder && !s.isOrganizer, "never automatically host or organizer");
        T.assert(s.currentPlayerId !== rawRoom(fake, code).hostId || mode === "computer", "the turn is valid");
      }
      // Two taps at once still only add them once.
      await game.leaveGame(code, P.id);
      await Promise.all([game.comeBack(code, P.id), game.comeBack(code, P.id), game.comeBack(code, P.id)]);
      T.assert(noDupes(rawOrder(fake, code)) && rawOrder(fake, code).includes(P.id), "simultaneous come-backs add them once");
    });

    await T.test(`${mode}: coming back with name and PIN from another device (a new token; the old one still works)`, async () => {
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: 3 });
      await startRound(game, fake, code);
      const room = rawRoom(fake, code);
      const P = players.find((p) => p.id !== room.hostId && p.id !== room.controlsId);
      const oldToken = game.tokenOf(P.id);
      await game.leaveGame(code, P.id);
      const bad = await game.rejoinRoom(code, P.name, "9999");
      T.assert(!!bad.error && /wrong pin/i.test(bad.error), "a wrong PIN is still refused");
      const back = await game.rejoinRoom(code, P.name, "1111");
      T.assert(!back.error, `rejoin: ${back.error}`);
      T.eq(back.playerId, P.id, "same seat");
      T.assert(back.token && back.token !== oldToken, "a fresh token for the new device");
      T.assert(!rawOrder(fake, code).slice(0, -1).includes(P.id) && rawOrder(fake, code).at(-1) === P.id, "at the end of the order");
      const viaNew = await game.getState(code, { id: P.id, token: back.token });
      const viaOld = await game.getState(code, { id: P.id, token: oldToken });
      T.assert(viaNew.me && !viaNew.me.removed, "new token works");
      T.assert(viaOld.me && !viaOld.me.removed, "old device keeps its token, and it works too");
    });

    await T.test(`${mode}: same round keeps this round's guesses; a later round starts clean; scores always kept`, async () => {
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: 4 });
      await startRound(game, fake, code);
      const guesser = await wrongGuess(game, fake, code, players[0].id);
      await game.leaveGame(code, guesser);
      await game.comeBack(code, guesser);
      T.eq((await game.getState(code, guesser)).me.history.length, 1, "their guess from this round is kept");
      await game.leaveGame(code, guesser);
      // Move to the next round while they're away.
      const controls = rawRoom(fake, code).controlsId;
      await game.endRound(code, controls);
      if (mode === "computer") await game.newRound(code, controls);
      else await startRound(game, fake, code);
      const away = await game.getState(code, guesser);
      T.eq(away.players.find((p) => p.id === guesser).history.length, 0, "a new round clears everyone's guesses, even the away player's");
      await game.comeBack(code, guesser);
      T.eq((await game.getState(code, guesser)).me.history.length, 0, "coming back later, they start the round with no guesses");
    });

    await T.test(`${mode}: someone who is away can only read the game and come back`, async () => {
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: 4 });
      await startRound(game, fake, code);
      const room = rawRoom(fake, code);
      const P = players.find((p) => p.id !== room.hostId && p.id !== room.controlsId);
      const other = players.find((p) => p.id !== P.id);
      await game.leaveGame(code, P.id);
      const s = await game.getState(code, P.id);
      T.assert(s.me && s.me.removed && s.me.leaveReason === "left", "they can read the state");
      T.assert(Array.isArray(s.chat), "and the chat");
      const secret = randomValidNumber(4);
      for (const [name, res] of [
        ["guess", await game.submitGuess(code, P.id, randomValidNumber(4))],
        ["pick", await game.pickSecret(code, P.id, secret)],
        ["skip", await game.skipTurn(code, P.id)],
        ["remove", await game.removePlayer(code, P.id, other.id)],
        ["restore", await game.restorePlayer(code, P.id, other.id)],
        ["end round", await game.endRound(code, P.id)],
        ["new round", await game.newRound(code, P.id)],
        ["chat", await game.sendChatMessage(code, P.id, { text: "hi" })],
        ["chat statement", await game.sendChatMessage(code, P.id, { presetId: "nice-guess" })],
        ["leave again", await game.leaveGame(code, P.id)],
      ]) T.assert(!!res.error, `an away player must not be able to ${name}`);
      // Never gets a turn while away.
      for (let i = 0; i < 6; i++) {
        const st = await game.getState(code, other.id);
        T.assert(st.currentPlayerId !== P.id, "an away player never gets a turn");
        if (st.currentPlayerId) await wrongGuess(game, fake, code, other.id);
      }
    });

    await T.test(`${mode}: removed players can't come back by themselves; Restore is the only way, and away players don't show as removed`, async () => {
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: 4 });
      await startRound(game, fake, code);
      const room = rawRoom(fake, code);
      const controls = room.controlsId;
      const [victim, leaver] = players.filter((p) => p.id !== room.hostId && p.id !== controls);
      T.assert(!(await game.removePlayer(code, controls, victim.id)).error, "removed");
      T.assert(!(await game.leaveGame(code, leaver.id)).error, "another one leaves");
      T.assert(!!(await game.comeBack(code, victim.id)).error, "a removed player can't use Rejoin");
      T.assert(!!(await game.rejoinRoom(code, victim.name, "1111")).error, "nor name + PIN");
      T.assert(!!(await game.restorePlayer(code, controls, leaver.id)).error, "the host can't 'restore' someone who simply left");
      const st = await game.getState(code, controls);
      const removedList = st.players.filter((p) => p.removed && p.leaveReason === "removed").map((p) => p.id);
      T.eq(removedList.length, 1, "the Removed list has only removed players");
      T.eq(removedList[0], victim.id, "not the one who left");
      T.assert(!(await game.restorePlayer(code, controls, victim.id)).error, "Restore works");
      T.assert(!!(await game.getState(code, victim.id)).me && !(await game.getState(code, victim.id)).me.removed, "restored");
    });
  }

  await T.test("rotating: the host leaving mid-round and coming back is a normal player (never host, never sees the number)", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 3 });
    await startRound(game, fake, code);
    const host = rawRoom(fake, code).hostId;
    T.assert(!(await game.leaveGame(code, host)).error, "host leaves");
    T.assert(!(await game.comeBack(code, host)).error, "host comes back");
    const s = await game.getState(code, host);
    T.assert(!s.isHost && !s.isControlsHolder, "not host, not controls");
    T.eq(s.secret, null, "and never sees the number");
    T.eq(rawOrder(fake, code).at(-1), host, "in the turn order like anyone");
    T.eq(rawRoom(fake, code).hostId, null, "the round stays hostless");
    void players;
  });

  await T.test("computer: the organizer leaving and coming back is a normal player; controls stay with whoever took over", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const org = rawRoom(fake, code).creatorId;
    await game.leaveGame(code, org);
    const took = rawRoom(fake, code).controlsId;
    T.assert(took && took !== org, "controls moved on");
    await game.comeBack(code, org);
    const s = await game.getState(code, org);
    T.assert(!s.isOrganizer && !s.isControlsHolder, "not the organizer anymore");
    T.eq(rawRoom(fake, code).controlsId, took, "still with the stand-in");
    void players;
  });

  for (const mode of MODES) {
    await T.test(`${mode}: everyone leaves — the game stays open, and the first to come back (or join) gets the controls`, async () => {
      for (const phase of ["pending-or-active", "between"]) {
        const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: 3 });
        if (phase === "between") {
          await startRound(game, fake, code);
          await game.endRound(code, rawRoom(fake, code).controlsId);
        } else await startRound(game, fake, code);
        for (const p of players) {
          const out = await game.leaveGame(code, p.id);
          T.assert(!out.error, `${p.name} leaves: ${out.error}`);
        }
        const gone = rawRoom(fake, code);
        T.assert(gone !== null, "the room still exists");
        T.eq(gone.controlsId, null, "nobody holds controls");
        T.eq(rawOrder(fake, code).length, 0, "empty turn order");
        const anon = await game.getState(code, { id: "x", token: "y" });
        T.assert(anon && anon.players.length === players.length, "the game is still readable");

        const first = players[1];
        T.assert(!(await game.comeBack(code, first.id)).error, "first back");
        const s = await game.getState(code, first.id);
        T.assert(s.isControlsHolder, "gets the controls");
        if (mode === "rotating" && rawRoom(fake, code).roundState === "pending") T.assert(s.isHost, "and hosts, since a round is waiting for a number");
        if (mode === "rotating" && rawRoom(fake, code).roundState === "active") T.assert(!s.isHost, "mid-round it stays hostless");
        const second = players[2];
        await game.comeBack(code, second.id);
        const s2 = await game.getState(code, second.id);
        T.assert(!s2.isControlsHolder && !s2.isHost, "the second person back is a normal player");
        if (rawRoom(fake, code).roundState === "active") {
          const cur = (await game.getState(code, first.id)).currentPlayerId;
          T.assert(!!cur && rawOrder(fake, code).includes(cur), "someone has a valid turn");
        }
      }
    });

    await T.test(`${mode}: everyone leaves; a brand-new joiner picks up the controls`, async () => {
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: 2 });
      for (const p of players) await game.leaveGame(code, p.id);
      const j = await game.joinRoom(code, "Newbie", "3333");
      T.assert(!j.error, `join: ${j.error}`);
      const s = await game.getState(code, j.playerId);
      T.assert(s.isControlsHolder, "controls");
      if (mode === "rotating") T.assert(s.isHost, "host (a round is waiting for a number)");
    });
  }

  await T.test("rotating: a hostless round can end with everyone back, and hosting continues correctly", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 3 });
    await startRound(game, fake, code);
    const host = rawRoom(fake, code).hostId;
    await game.leaveGame(code, host);
    await game.comeBack(code, host);
    const controls = rawRoom(fake, code).controlsId;
    await game.endRound(code, controls);
    // B was the departed... A (host) left: next active after A is B
    T.eq(rawRoom(fake, code).hostId, players[1].id, "next after the departed host");
  });

  await T.test("the away player's data survives: name, PIN, score, and their place after several leave/come-back cycles", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const p = players[2];
    const before = rawPlayer(fake, code, p.id);
    for (let i = 0; i < 3; i++) { await game.leaveGame(code, p.id); await game.comeBack(code, p.id); }
    const after = rawPlayer(fake, code, p.id);
    T.eq(after.joinSeq, before.joinSeq, "hosting place never changes");
    T.eq(after.pinHash, before.pinHash, "PIN unchanged");
    T.eq(after.leaveCount, 3, "three departures counted");
  });
}
