import { createGameWithPlayers, rawRoom, randomValidNumber } from "./helpers.js";

export default async function run({ game, fake, T }) {
  T.suite("Validation at every digit length");

  for (const digits of [3, 4, 5]) {
    await T.test(`isValidSecret rejects malformed values for ${digits} digits`, async () => {
      const valid = randomValidNumber(digits);
      T.assert(game.isValidSecret(valid, digits), "a freshly generated valid number should pass");

      const repeated = valid[0] + valid.slice(0, -1); // repeats the first digit
      T.assert(!game.isValidSecret(repeated, digits), "repeated digits should be rejected");

      const leadingZero = "0" + valid.slice(1);
      T.assert(!game.isValidSecret(leadingZero, digits), "a leading 0 should be rejected");

      T.assert(!game.isValidSecret(valid + "1", digits), "wrong length (too long) should be rejected");
      T.assert(!game.isValidSecret(valid.slice(0, -1), digits), "wrong length (too short) should be rejected");

      const withLetters = "a" + valid.slice(1);
      T.assert(!game.isValidSecret(withLetters, digits), "letters should be rejected");
    });
  }

  await T.test("a wrong-length guess sent directly to the API is rejected using the room's own digit count", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 5, count: 2 });
    const state = await game.getState(code, players[0].id);
    // A well-formed 4-digit guess in a 5-digit game — as if a client bypassed
    // its own UI validation and posted straight to the API.
    const fourDigitGuess = randomValidNumber(4);
    const out = await game.submitGuess(code, state.currentPlayerId, fourDigitGuess);
    T.assert(!!out.error, "a guess of the wrong length for this room should be rejected server-side");
  });

  await T.test("createRoom validates digits and PIN, never trusting an out-of-range value", async () => {
    const badDigits = await game.createRoom("Ana", "1234", "computer", 6);
    T.assert(!!badDigits.error, "digits outside 3-5 should be rejected");
    const badPin = await game.createRoom("Ana", "12a4", "computer", 4);
    T.assert(!!badPin.error, "a non-numeric PIN should be rejected");
    const shortPin = await game.createRoom("Ana", "123", "computer", 4);
    T.assert(!!shortPin.error, "a PIN that isn't 4 digits should be rejected");
    const badMode = await game.createRoom("Ana", "1234", "chaos", 4);
    T.assert(!!badMode.error, "an unknown mode should be rejected");
  });

  T.suite("Duplicate guess protection");

  await T.test("a repeated guess is rejected with a clear error and does not use up the turn", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    const secret = room.secret;
    const decoy = randomValidNumber(4, new Set([secret]));

    const state1 = await game.getState(code, players[0].id);
    const curId1 = state1.currentPlayerId;
    const first = await game.submitGuess(code, curId1, decoy);
    T.assert(!first.error, "first guess should succeed");

    const state2 = await game.getState(code, players[0].id);
    const curId2 = state2.currentPlayerId;
    T.assert(curId2 !== curId1, "turn should have advanced after the first guess");

    const beforeTries = (await game.getState(code, curId2)).me.history.length;
    const dup = await game.submitGuess(code, curId2, decoy);
    T.assert(!!dup.error, "a repeated guess should be rejected");
    T.assert(/already tried/i.test(dup.error), `error message should explain the duplicate, got: ${dup.error}`);

    const state3 = await game.getState(code, players[0].id);
    T.eq(state3.currentPlayerId, curId2, "the turn should still belong to the same player after a rejected duplicate");
    const afterTries = (await game.getState(code, curId2)).me.history.length;
    T.eq(afterTries, beforeTries, "the rejected duplicate should not be added to the player's history");
  });
}
