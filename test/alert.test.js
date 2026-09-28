import { canPlayerGuess } from "../lib/client.js";

// Covers the "Your turn" alert's trigger condition: canPlayerGuess() is the
// exact predicate page.js uses both to enable the guess UI and to decide
// when to vibrate/beep/retitle the tab (on its false -> true transition).
// A player's alert should never fire while they're the rotating host,
// between rounds, after they've already solved it, or when it's simply not
// their turn.
//
// The two other behaviors called out for this feature —
//   - the tab title is restored once it's no longer this player's turn
//     (page.js's title effect's cleanup always runs before the next value is
//     applied, and restores the pre-game title on unmount), and
//   - hidden-tab polling (every 10s instead of every 2s) can't break the
//     stale-response protection in refresh() (the request-id check that
//     drops an out-of-order response applies identically no matter what
//     triggered the fetch)
// are structural guarantees of page.js that don't reduce to a pure function,
// and this project has no DOM/React test harness (no jsdom / testing-library
// dependency) to mount the component in. They were verified by reading
// app/game/[code]/page.js directly: the title effect's cleanup
// (`return () => { document.title = originalTitle.current; }`) runs on
// every re-render and on unmount, and refresh()'s `id !== requestIdRef.current`
// guard is keyed only on request order, not on the interval/visibility logic
// that decided whether to call it.
export default async function run({ T }) {
  T.suite("\"Your turn\" alert trigger logic (canPlayerGuess)");

  const base = { roundState: "active", isHostThisRound: false, solved: false, currentPlayerId: "p1", playerId: "p1" };

  await T.test("true exactly when active, not host, not solved, and it's this player's turn", async () => {
    T.eq(canPlayerGuess(base), true, "all conditions met should allow guessing");
  });

  await T.test("never true for the rotating host, regardless of anything else", async () => {
    T.eq(canPlayerGuess({ ...base, isHostThisRound: true }), false, "the host should never be alerted/allowed to guess");
    T.eq(canPlayerGuess({ ...base, isHostThisRound: true, currentPlayerId: "p1" }), false, "host + matching id should still be false");
  });

  await T.test("never true between rounds (pending or ended)", async () => {
    T.eq(canPlayerGuess({ ...base, roundState: "pending" }), false, "pending round should never allow guessing");
    T.eq(canPlayerGuess({ ...base, roundState: "ended" }), false, "ended round should never allow guessing");
  });

  await T.test("never true once this player has already solved it", async () => {
    T.eq(canPlayerGuess({ ...base, solved: true }), false, "an already-solved player should not be alerted again");
  });

  await T.test("never true when it's someone else's turn", async () => {
    T.eq(canPlayerGuess({ ...base, currentPlayerId: "someone-else" }), false, "not-my-turn should be false");
    T.eq(canPlayerGuess({ ...base, currentPlayerId: null }), false, "no current player (e.g. empty room) should be false");
  });

  await T.test("the alert's rising-edge fires exactly when the turn passes to this player, once per pass", async () => {
    // Mirrors page.js's `if (canGuess && !wasMyTurn.current)` exactly: an
    // alert on the false -> true transition only, tracked across a sequence
    // of states the way the component's ref does across renders.
    const sequence = [
      { ...base, roundState: "pending", currentPlayerId: null },       // waiting for host to pick
      { ...base, currentPlayerId: "someone-else" },                    // round active, someone else's turn
      { ...base, currentPlayerId: "p1" },                              // -> my turn (should alert)
      { ...base, currentPlayerId: "p1" },                              // still my turn (re-render, no re-alert)
      { ...base, currentPlayerId: "someone-else" },                    // turn passes on
      { ...base, roundState: "ended" },                                // round ends
      { ...base, roundState: "pending", currentPlayerId: null },       // next round pending
      { ...base, currentPlayerId: "p1" },                              // -> my turn again (should alert again)
    ];

    let wasMyTurn = false;
    const alerts = [];
    for (const [i, s] of sequence.entries()) {
      const canGuess = canPlayerGuess(s);
      if (canGuess && !wasMyTurn) alerts.push(i);
      wasMyTurn = canGuess;
    }
    T.eq(alerts.length, 2, `expected exactly 2 alerts, got ${alerts.length} at indices ${alerts.join(",")}`);
    T.eq(alerts[0], 2, "first alert should fire the moment it first becomes my turn");
    T.eq(alerts[1], 7, "second alert should fire the next time it becomes my turn, not on every render while it stays my turn");
  });

  await T.test("becoming the rotating host mid-sequence suppresses the alert even if currentPlayerId briefly still matches stale data", async () => {
    const sequence = [
      { ...base, currentPlayerId: "someone-else" },
      { ...base, isHostThisRound: true, currentPlayerId: "p1" }, // stale currentPlayerId, but now host
    ];
    let wasMyTurn = false;
    const alerts = [];
    for (const [i, s] of sequence.entries()) {
      const canGuess = canPlayerGuess(s);
      if (canGuess && !wasMyTurn) alerts.push(i);
      wasMyTurn = canGuess;
    }
    T.eq(alerts.length, 0, "the host should never be alerted, even with a stale matching currentPlayerId");
  });
}
