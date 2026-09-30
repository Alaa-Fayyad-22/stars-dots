import { createGameWithPlayers, rawRoom, randomValidNumber } from "./helpers.js";

// Tests the scratch sheet's "Submit guess" feature. The enable/disable
// reasoning lives in lib/client.js's draftGuessReason() (used verbatim by
// the scratch sheet's UI, see app/game/[code]/page.js), so it's tested
// directly here rather than through a browser/component harness. The actual
// submit itself goes through the exact same lib/game.js#submitGuess() as
// the main "Check guess" button (both call submitGuessValue(), which POSTs
// to /api/guess) — already exhaustively covered by the rest of the suite —
// so here we confirm that shared path really does record the guess and
// advance the turn when driven with a scratch-sheet-style draft value.
export default async function run({ game, fake, T }) {
  T.suite("Scratch sheet: submit guess");

  await T.test("draftGuessReason: disabled with a specific reason for every invalid case", async () => {
    const { draftGuessReason, findDuplicateGuess } = await import("../lib/client.js");
    const base = {
      digits: 4,
      players: [],
      playerId: "p1",
      roundState: "active",
      isHostThisRound: false,
      solved: false,
      currentPlayerId: "p1",
    };

    T.eq(draftGuessReason({ ...base, draft: ["1", "2", "3", "4"], roundState: "pending" }), "Round isn't active");
    T.eq(draftGuessReason({ ...base, draft: ["1", "2", "3", "4"], roundState: "ended" }), "Round isn't active");
    T.eq(draftGuessReason({ ...base, draft: ["1", "2", "3", "4"], isHostThisRound: true }), "The host doesn't guess this round");
    T.eq(draftGuessReason({ ...base, draft: ["1", "2", "3", "4"], solved: true }), "You already found it");
    T.eq(draftGuessReason({ ...base, draft: ["1", "2", "3", "4"], currentPlayerId: "someone-else" }), "Waiting for the next player");
    T.eq(draftGuessReason({ ...base, draft: ["1", "2", "3", ""] }), "Fill in all the digits");
    T.eq(draftGuessReason({ ...base, draft: ["0", "1", "2", "3"] }), "Can't start with 0");
    T.eq(draftGuessReason({ ...base, draft: ["1", "1", "2", "3"] }), "Repeated digits");

    const players = [{ id: "p2", name: "Ana", history: [{ guess: "1234", stars: 1, dots: 2, at: 1 }] }];
    T.eq(draftGuessReason({ ...base, draft: ["1", "2", "3", "4"], players }), "Ana already tried this: ★●●");
    T.assert(findDuplicateGuess(players, "1234", "p1"), "sanity check: findDuplicateGuess should agree there's a duplicate");

    // Valid: nothing wrong, so no reason — the button should be enabled.
    T.eq(draftGuessReason({ ...base, draft: ["1", "2", "3", "4"] }), null);
  });

  await T.test("draftGuessReason matches the room's actual digit count (3/4/5)", async () => {
    const { draftGuessReason } = await import("../lib/client.js");
    for (const digits of [3, 4, 5]) {
      const valid = randomValidNumber(digits).split("");
      const base = { digits, players: [], playerId: "p1", roundState: "active", isHostThisRound: false, solved: false, currentPlayerId: "p1" };
      T.eq(draftGuessReason({ ...base, draft: valid }), null, `a valid ${digits}-digit draft should be submittable`);
      T.eq(draftGuessReason({ ...base, draft: valid.slice(0, -1).concat("") }), "Fill in all the digits", `an incomplete ${digits}-digit draft should be rejected`);
    }
  });

  await T.test("submitting a valid draft (via the shared /api/guess path) records the guess and passes the turn, exactly like the main button", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    const state1 = await game.getState(code, players[0].id);
    const curId = state1.currentPlayerId;
    const decoy = randomValidNumber(4, new Set([room.secret]));

    // This is exactly what submitDraftGuess() sends: the same submitGuess()
    // call the main "Check guess" button uses.
    const result = await game.submitGuess(code, curId, decoy);
    T.assert(!result.error, `a valid draft guess should be accepted, got: ${result.error}`);

    const state2 = await game.getState(code, curId);
    T.assert(state2.me.history.some((h) => h.guess === decoy), "the guess should be recorded in the player's history");
    T.assert(state2.currentPlayerId !== curId, "the turn should have passed to the next player");
  });

  await T.test("a rejected draft guess (e.g. a race on turn/duplicate) reports a clear error and doesn't consume the turn", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const state1 = await game.getState(code, players[0].id);
    const curId = state1.currentPlayerId;
    const notCurrent = players.find((p) => p.id !== curId).id;

    // Simulates submitDraftGuess() firing after the turn moved on from under
    // the player (the same rejection path the main button hits too).
    const result = await game.submitGuess(code, notCurrent, "1937");
    T.assert(!!result.error, "an out-of-turn draft submit should be rejected");

    const state2 = await game.getState(code, players[0].id);
    T.eq(state2.currentPlayerId, curId, "the turn should be unaffected by the rejected submit");
  });
}
