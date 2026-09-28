import { createGameWithPlayers, rawRoom, randomValidNumber } from "./helpers.js";

// Regression coverage for the reported bug: a rotating host was removed
// mid-round (the only way that was ever possible was self-removal, since
// removePlayer() requires the requester to already hold host controls), a
// new player joined afterward, and their screen said "Your turn" while
// "Check guess" rejected them with "It's not your turn." — the screen and
// the server had drifted apart.
//
// These tests reproduce the exact steps from the report and fail against
// the old code: `leaveGame` didn't exist there at all (host departure only
// ever went through the generic, now-forbidden self-removal path), and that
// old path immediately promoted a new host who (a) got handed the secret
// for the round already in progress — a real leak, verified empirically
// against the pre-fix code — and (b) was wrongly excluded from the turn
// rotation even though nothing should stop them from continuing to play.
export default async function run({ game, fake, T }) {
  T.suite("Host removal / leaveGame — the reported bug, reproduced step for step");

  await T.test("step 1-2: only the host can remove the host, and only by self-removal — which is now rejected", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    await game.pickSecret(code, room.hostId, randomValidNumber(4));

    // Nobody but the host has permission to remove the host at all.
    const nonHost = players.find((p) => p.id !== room.hostId);
    const byOther = await game.removePlayer(code, nonHost.id, room.hostId);
    T.assert(!!byOther.error, "a non-host should never be able to remove the host");

    // The host itself can't self-remove either — that's what made this bug
    // possible in the first place. "Leave game" is the only way out now.
    const bySelf = await game.removePlayer(code, room.hostId, room.hostId);
    T.assert(!!bySelf.error, "self-removal must be rejected, including for the host");
    T.assert(/leave game/i.test(bySelf.error), "the error should point at Leave game");
  });

  await T.test("step 2: the host leaving mid-round does not leak the in-progress secret to whoever takes over controls", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    const secret = randomValidNumber(4);
    await game.pickSecret(code, room.hostId, secret);

    const out = await game.leaveGame(code, room.hostId);
    T.assert(!out.error, `host leaving should succeed, got: ${out.error}`);

    const room2 = rawRoom(fake, code);
    T.eq(room2.hostId, null, "the round should be hostless — nobody owns the secret for the rest of it");
    T.eq(room2.secret, secret, "the in-progress secret itself must be untouched");
    T.assert(!!room2.controlsId && room2.controlsId !== room.hostId, "someone else should hold controls");

    const controlsState = await game.getState(code, room2.controlsId);
    T.eq(controlsState.secret, null, "the controls-holder must NOT see the secret they didn't pick");
    T.assert(!controlsState.isHost, "the controls-holder is not 'the host' during a hostless round");
    T.assert(controlsState.isControlsHolder, "but they do hold host controls");
    T.eq(controlsState.roundState, "active", "the round keeps going, same as before");

    for (const p of players) {
      const s = await game.getState(code, p.id);
      T.eq(s.secret, null, `${p.name} must never see the hostless round's secret`);
    }
  });

  await T.test("steps 2-4: the exact reported sequence — host leaves mid-round, a new player joins, and the screen and server agree on whose turn it is throughout", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    const secret = randomValidNumber(4);
    await game.pickSecret(code, room.hostId, secret);

    // "The host was removed. The host role passed to the next player, so
    // now there was 1 new host and 1 player."
    const leave = await game.leaveGame(code, room.hostId);
    T.assert(!leave.error, `host leaving should succeed, got: ${leave.error}`);

    // "A new player C joined."
    const c = await game.joinRoom(code, "Cleo2", "2222");
    T.assert(!c.error, `late join should succeed, got: ${c.error}`);

    // Play the round out. At every single step, getState's currentPlayerId
    // must exactly predict who submitGuess will accept — including once
    // it's specifically C's turn.
    const everyone = [...players, { id: c.playerId, name: "Cleo2" }];
    let cWasCurrentAndGuessed = false;
    for (let step = 0; step < 12; step++) {
      const s = await game.getState(code, c.playerId);
      if (s.roundState !== "active") break;
      T.assert(!!s.currentPlayerId, `there should always be a current player mid-round (step ${step})`);
      const whoThinks = everyone.find((p) => p.id === s.currentPlayerId);
      T.assert(!!whoThinks, `currentPlayerId must match a real, still-in-the-game player (step ${step})`);

      const usedGuesses = new Set([secret]);
      for (const pl of s.players) for (const h of pl.history) usedGuesses.add(h.guess);
      const guessVal = randomValidNumber(4, usedGuesses);
      const g = await game.submitGuess(code, whoThinks.id, guessVal);
      T.assert(!g.error, `getState said it was ${whoThinks.name}'s turn (step ${step}), but submitGuess rejected it: ${g.error}`);
      if (whoThinks.id === c.playerId) cWasCurrentAndGuessed = true;
      if (g.won) break;
    }
    T.assert(cWasCurrentAndGuessed, "C should have gotten (and successfully taken) at least one turn in this run");
  });

  await T.test("the hostless round's controls-holder can also leave, and controls pass on again", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 4 });
    const room = rawRoom(fake, code);
    await game.pickSecret(code, room.hostId, randomValidNumber(4));
    await game.leaveGame(code, room.hostId);

    const room2 = rawRoom(fake, code);
    T.eq(room2.hostId, null, "still hostless");
    const firstControls = room2.controlsId;

    const selfRemove = await game.removePlayer(code, firstControls, firstControls);
    T.assert(!!selfRemove.error, "the controls-holder can't self-remove either");

    const out = await game.leaveGame(code, firstControls);
    T.assert(!out.error, `the controls-holder should be able to leave too, got: ${out.error}`);
    const room3 = rawRoom(fake, code);
    T.eq(room3.hostId, null, "still hostless — leaving controls-holder doesn't restore a host");
    T.assert(room3.controlsId && room3.controlsId !== firstControls, "controls should have passed to someone else");
  });

  await T.test("winning a hostless round still makes the winner the next host", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    const secret = randomValidNumber(4);
    await game.pickSecret(code, room.hostId, secret);
    await game.leaveGame(code, room.hostId);

    let winnerId = null;
    for (let i = 0; i < 10; i++) {
      const s = await game.getState(code, players[0].id);
      if (!s.currentPlayerId) break;
      const g = await game.submitGuess(code, s.currentPlayerId, i === 9 ? secret : randomValidNumber(4, new Set([secret])));
      if (g.won) { winnerId = s.currentPlayerId; break; }
    }
    T.assert(!!winnerId, "someone should have won");
    const room2 = rawRoom(fake, code);
    T.eq(room2.hostId, winnerId, "the winner becomes the next host, hostless round or not");
    T.eq(room2.controlsId, winnerId, "and picks up controls too");
  });

  await T.test("ending a hostless round hands hosting to whoever was holding controls", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    await game.pickSecret(code, room.hostId, randomValidNumber(4));
    await game.leaveGame(code, room.hostId);
    const room2 = rawRoom(fake, code);

    const out = await game.endRound(code, room2.controlsId);
    T.assert(!out.error, `ending a hostless round should succeed, got: ${out.error}`);
    const room3 = rawRoom(fake, code);
    T.eq(room3.hostId, room2.controlsId, "the controls-holder becomes the next host");
    T.eq(room3.roundState, "pending", "waiting for the new host to pick a number");
  });

  await T.test("leaving between rounds (pending, no secret picked yet) hands hosting over immediately", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    T.eq(room.roundState, "pending", "sanity: game starts pending");

    const out = await game.leaveGame(code, room.hostId);
    T.assert(!out.error, `leaving while pending should succeed, got: ${out.error}`);
    const room2 = rawRoom(fake, code);
    T.assert(!!room2.hostId && room2.hostId !== room.hostId, "a new host should be assigned immediately, not left hostless");
    T.eq(room2.controlsId, room2.hostId, "the new host also holds controls");

    const pick = await game.pickSecret(code, room2.hostId, randomValidNumber(4));
    T.assert(!pick.error, `the new host should be able to pick a number, got: ${pick.error}`);
  });

  await T.test("computer mode: the organizer leaving passes controls on, players keep playing", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const room = rawRoom(fake, code);

    const selfRemove = await game.removePlayer(code, room.creatorId, room.creatorId);
    T.assert(!!selfRemove.error, "the organizer can't self-remove via removePlayer");

    const before = await game.getState(code, room.creatorId);
    const out = await game.leaveGame(code, room.creatorId);
    T.assert(!out.error, `organizer leaving should succeed, got: ${out.error}`);
    const room2 = rawRoom(fake, code);
    T.assert(!!room2.controlsId && room2.controlsId !== room.creatorId, "controls should pass to someone else");

    const after = await game.getState(code, room2.controlsId);
    T.assert(after.isOrganizer, "the new controls-holder is recognized as the organizer");
    if (before.currentPlayerId !== room.creatorId) {
      T.eq(after.currentPlayerId, before.currentPlayerId, "leaving the organizer seat shouldn't disturb someone else's turn");
    } else {
      T.assert(after.currentPlayerId && after.currentPlayerId !== room.creatorId, "if it was the departing organizer's own turn, it should move on to someone still in the game");
    }
  });

  await T.test("computer mode: if literally everyone leaves, the next joiner becomes organizer", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 2 });
    const room = rawRoom(fake, code);
    const other = players.find((p) => p.id !== room.creatorId);
    await game.removePlayer(code, room.creatorId, other.id);
    await game.leaveGame(code, room.creatorId);

    const room2 = rawRoom(fake, code);
    T.eq(room2.controlsId, null, "nobody left to hold controls");

    const j = await game.joinRoom(code, "Fresh", "4444");
    T.assert(!j.error, `joining an empty-of-controls game should succeed, got: ${j.error}`);
    const room3 = rawRoom(fake, code);
    T.eq(room3.controlsId, j.playerId, "the new joiner should pick up controls");
    const s = await game.getState(code, j.playerId);
    T.assert(s.isOrganizer, "and be recognized as organizer");
  });
}
