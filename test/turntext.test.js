import { turnText, currentTurnName, guessButtonLabel, sheetStatus, draftGuessReason } from "../lib/client.js";
import { createGameWithPlayers, rawRoom, randomValidNumber } from "./helpers.js";

// "Whose turn is it" text. These are the exact functions the game screen uses
// for the main guess button, the scratch sheet's "Submit guess" reason, and
// the scratch sheet's status line, fed with the same currentPlayerId/players
// that getState sends — so the tests below also run them on real getState
// output to prove they can't disagree with the server.
export default async function run({ game, fake, T }) {
  T.suite("Turn text (whose turn it is)");

  const players = [
    { id: "a", name: "Ana", removed: false, history: [] },
    { id: "b", name: "Boro", removed: false, history: [] },
    { id: "c", name: "Cleo", removed: true, history: [] },
  ];

  await T.test("the button says the current player's name instead of \"Not your turn\"", async () => {
    T.eq(turnText(players, "a"), "Ana's turn");
    T.eq(guessButtonLabel({ canGuess: false, players, currentPlayerId: "a" }), "Ana's turn");
    T.eq(guessButtonLabel({ canGuess: false, players, currentPlayerId: "b" }), "Boro's turn");
    T.eq(guessButtonLabel({ canGuess: true, players, currentPlayerId: "b" }), "Check guess", "my own turn still says Check guess");
    T.assert(!/not your turn/i.test(guessButtonLabel({ canGuess: false, players, currentPlayerId: "a" })), "old wording is gone");
  });

  await T.test("the scratch sheet's Submit-guess reason names the current player too", async () => {
    const base = { draft: ["1", "2", "3", "4"], digits: 4, players, playerId: "b", roundState: "active", isHostThisRound: false, solved: false };
    T.eq(draftGuessReason({ ...base, currentPlayerId: "a" }), "Ana's turn");
    T.eq(draftGuessReason({ ...base, currentPlayerId: "b" }), null, "my turn: submittable");
  });

  await T.test("fallback: the current player has left / was removed / can't be found -> \"Waiting for the next player\"", async () => {
    const F = "Waiting for the next player";
    T.eq(turnText(players, "c"), F, "removed or left");
    T.eq(turnText(players, "nobody"), F, "unknown id");
    T.eq(turnText(players, null), F, "no current player");
    T.eq(turnText(players, undefined), F);
    T.eq(turnText([], "a"), F, "empty player list");
    T.eq(turnText(undefined, "a"), F, "missing player list");
    T.eq(guessButtonLabel({ canGuess: false, players, currentPlayerId: "c" }), F);
    T.eq(draftGuessReason({ draft: ["1", "2", "3", "4"], digits: 4, players, playerId: "b", roundState: "active", isHostThisRound: false, solved: false, currentPlayerId: "c" }), F);
    T.eq(sheetStatus({ roundState: "active", playerId: "b", players, currentPlayerId: "c" }).text, F);
    T.eq(currentTurnName(players, "c"), null);
  });

  await T.test("sheet status line: \"Your turn\" (highlighted) on my turn, \"Ana's turn\" on someone else's", async () => {
    const base = { roundState: "active", isHostThisRound: false, solved: false, playerId: "b", players, hostName: null };
    const mine = sheetStatus({ ...base, currentPlayerId: "b" });
    T.eq(mine.text, "Your turn");
    T.eq(mine.mine, true, "highlighted on my turn");
    const theirs = sheetStatus({ ...base, currentPlayerId: "a" });
    T.eq(theirs.text, "Ana's turn");
    T.eq(theirs.mine, false);
    T.eq(sheetStatus({ ...base, currentPlayerId: "b", solved: true }).text, "You already found it");
  });

  await T.test("sheet status between rounds: waiting for the host to pick, or round over", async () => {
    const base = { isHostThisRound: false, solved: false, playerId: "b", players, currentPlayerId: null };
    T.eq(sheetStatus({ ...base, roundState: "pending", hostName: "Ana" }).text, "Waiting for Ana to pick the number");
    T.eq(sheetStatus({ ...base, roundState: "pending", hostName: null }).text, "Waiting for the host to pick the number");
    T.eq(sheetStatus({ ...base, roundState: "ended" }).text, "Round over");
    T.eq(sheetStatus({ ...base, roundState: "pending", hostName: "Ana" }).mine, false);
    T.eq(sheetStatus({ ...base, roundState: "ended" }).mine, false);
  });

  await T.test("it follows real server data: getState's currentPlayerId + players drive every text, in step with the server", async () => {
    const { code, players: ps } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    for (let step = 0; step < 4; step++) {
      const viewerState = await game.getState(code, ps[0].id);
      const curId = viewerState.currentPlayerId;
      const curName = ps.find((p) => p.id === curId).name;
      for (const viewer of ps) {
        const s = await game.getState(code, viewer.id);
        T.eq(s.currentPlayerId, curId, "all viewers see the same turn");
        const canGuess = s.roundState === "active" && !s.me.solved && s.currentPlayerId === viewer.id;
        const label = guessButtonLabel({ canGuess, players: s.players, currentPlayerId: s.currentPlayerId });
        const status = sheetStatus({ roundState: s.roundState, isHostThisRound: s.isHost, solved: s.me.solved, currentPlayerId: s.currentPlayerId, playerId: viewer.id, players: s.players, hostName: s.hostName });
        if (viewer.id === curId) {
          T.eq(label, "Check guess");
          T.eq(status.text, "Your turn");
        } else {
          T.eq(label, `${curName}'s turn`, `${viewer.name} should see whose turn it is`);
          T.eq(status.text, `${curName}'s turn`);
        }
      }
      const seen = new Set([room.secret, ...viewerState.players.flatMap((p) => p.history.map((h) => h.guess))]);
      const decoy = randomValidNumber(4, seen);
      T.assert(!(await game.submitGuess(code, curId, decoy)).error, "guess should pass");
    }
  });

  await T.test("real rounds: pending shows the host's name, a finished computer round shows \"Round over\"", async () => {
    const rot = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 3 });
    const s = await game.getState(rot.code, rot.players[1].id);
    T.eq(s.roundState, "pending");
    T.eq(sheetStatus({ roundState: s.roundState, isHostThisRound: s.isHost, solved: s.me.solved, currentPlayerId: s.currentPlayerId, playerId: s.me.id, players: s.players, hostName: s.hostName }).text, "Waiting for Ana to pick the number");

    const comp = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const room = rawRoom(fake, comp.code);
    const st = await game.getState(comp.code, comp.players[0].id);
    await game.submitGuess(comp.code, st.currentPlayerId, room.secret);
    const s2 = await game.getState(comp.code, comp.players[1].id);
    T.eq(s2.roundState, "ended");
    T.eq(sheetStatus({ roundState: s2.roundState, isHostThisRound: s2.isHost, solved: s2.me.solved, currentPlayerId: s2.currentPlayerId, playerId: s2.me.id, players: s2.players, hostName: s2.hostName }).text, "Round over");
  });

  await T.test("a current player who has left isn't shown as having the turn (real removal)", async () => {
    const { code, players: ps } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    await game.removePlayer(code, room.creatorId, ps[2].id);
    const after = await game.getState(code, ps[0].id);
    T.assert(after.currentPlayerId !== ps[2].id, "the server never keeps the turn on a removed player");
    T.eq(turnText(after.players, ps[2].id), "Waiting for the next player", "stale pointer at a removed player falls back");
  });
}
