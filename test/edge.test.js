import { createGameWithPlayers, rawRoom, randomValidNumber } from "./helpers.js";

export default async function run({ game, fake, T }) {
  T.suite("Mid-round joins, skip, remove, and mass removal");

  await T.test("a player can join mid-round without disturbing whose turn it is", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 2 });
    const before = await game.getState(code, players[0].id);
    const curBefore = before.currentPlayerId;
    const joined = await game.joinRoom(code, "Newbie", "9999");
    T.assert(!joined.error, "mid-round join should succeed");
    const after = await game.getState(code, players[0].id);
    T.eq(after.currentPlayerId, curBefore, "whose turn it is should be unaffected by a new player joining");
  });

  await T.test("host/organizer skip turn moves play to the next player", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    const before = await game.getState(code, players[0].id);
    const out = await game.skipTurn(code, room.creatorId);
    T.assert(!out.error, `organizer skip should succeed, got: ${out.error}`);
    const after = await game.getState(code, players[0].id);
    T.assert(after.currentPlayerId !== before.currentPlayerId, "turn should have advanced");
  });

  await T.test("removing a non-current player doesn't change whose turn it is", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 4 });
    const before = await game.getState(code, players[0].id);
    const curId = before.currentPlayerId;
    const target = players.find((p) => p.id !== curId && p.id !== rawRoom(fake, code).creatorId) || players.find((p) => p.id !== curId);
    const room = rawRoom(fake, code);
    const out = await game.removePlayer(code, room.creatorId, target.id);
    T.assert(!out.error, `remove should succeed, got: ${out.error}`);
    const after = await game.getState(code, players[0].id);
    if (curId !== target.id) T.eq(after.currentPlayerId, curId, "turn should be unaffected when removing someone else");
  });

  await T.test("removing the current player advances the turn to a valid remaining player", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 4 });
    const before = await game.getState(code, players[0].id);
    const curId = before.currentPlayerId;
    const room = rawRoom(fake, code);
    const out = await game.removePlayer(code, room.creatorId, curId);
    T.assert(!out.error, `remove should succeed, got: ${out.error}`);
    const after = await game.getState(code, players[0].id);
    T.assert(after.currentPlayerId !== null, "there should still be a current player");
    T.assert(after.currentPlayerId !== curId, "the removed player should no longer be current");
    const stillIn = after.players.find((p) => p.id === after.currentPlayerId);
    T.assert(stillIn && !stillIn.removed, "the new current player should not be removed");
  });

  await T.test("removing everyone leaves the game in a valid, non-crashing state", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    for (const p of players) {
      // The organizer can't be checked against itself once removed, so
      // always issue the removal from the organizer id directly.
      await game.removePlayer(code, room.creatorId, p.id);
    }
    const state = await game.getState(code, players[0].id);
    T.eq(state.currentPlayerId, null, "no current player once everyone is removed");
    T.assert(state.players.every((p) => p.removed), "every player should be marked removed");
    T.assert(state.scoreboard.every((e) => e.removed), "scoreboard should mark everyone as left");
    // A subsequent guess attempt should fail cleanly, not throw.
    const guessAttempt = await game.submitGuess(code, players[0].id, randomValidNumber(4));
    T.assert(!!guessAttempt.error, "guessing after being removed should fail cleanly");
  });

  await T.test("removing the current host (rotating) keeps the turn order valid", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 4 });
    const room1 = rawRoom(fake, code);
    await game.pickSecret(code, room1.hostId, randomValidNumber(4));
    const before = await game.getState(code, players[0].id);
    const room2 = rawRoom(fake, code);
    const out = await game.removePlayer(code, room2.hostId, room2.hostId);
    T.assert(!out.error, `host removing itself should succeed, got: ${out.error}`);
    const room3 = rawRoom(fake, code);
    T.assert(room3.hostId !== room2.hostId, "a new host should have taken over");
    const after = await game.getState(code, players[0].id);
    if (before.currentPlayerId !== room2.hostId) {
      T.assert(after.currentPlayerId !== null, "there should still be a valid current player");
    }
  });
}
