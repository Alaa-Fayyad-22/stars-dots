export default async function run({ game, fake, T }) {
  T.suite("Old-room compatibility and misc robustness");

  await T.test("a pre-update room (missing mode/digits) is treated as not found, not a crash", async () => {
    const code = "OLDXX";
    fake.store.set(`room:${code}`, {
      type: "string",
      value: JSON.stringify({ code, hostId: "abc", hostName: "Sam", secret: "1234", round: 1, winner: null, createdAt: Date.now() }),
      expiresAt: Date.now() + 60_000,
    });
    const state = await game.getState(code, "abc");
    T.eq(state, null, "an old-shaped room should read back as 'not found'");

    const guess = await game.submitGuess(code, "abc", "1234");
    T.assert(!!guess.error, "acting on an old-shaped room should fail cleanly, not throw");
    T.assert(/no longer exists/i.test(guess.error), "should report the room as gone");
  });

  await T.test("a totally unknown code returns null / a clean error everywhere", async () => {
    const state = await game.getState("NOPE0", "whoever");
    T.eq(state, null, "getState should return null for an unknown code");
    const join = await game.joinRoom("NOPE0", "Ana", "1234");
    T.assert(!!join.error, "joinRoom should error cleanly for an unknown code");
    const rejoin = await game.rejoinRoom("NOPE0", "Ana", "1234");
    T.assert(!!rejoin.error, "rejoinRoom should error cleanly for an unknown code");
  });
}
