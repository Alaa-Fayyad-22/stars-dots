import { rawRoom, refCheckGuess } from "./helpers.js";

// A valid number for every digit count, from rotations of 123456789: they're
// all different from each other, never start with 0 and never repeat a digit.
const num = (digits, k) => "123456789".repeat(2).slice(k, k + digits);

// The exact string/number value of `n` anywhere in a response (ids are UUIDs
// and times are long numbers, so neither can match a whole 3-5 digit value).
const carries = (obj, n) => new RegExp(`"${n}"|[:\\[,]${n}[,\\]}]`).test(JSON.stringify(obj));

export default async function run({ game, fake, T }) {
  T.suite("Duel");

  async function mk(digits = 4) {
    const a = await game.createRoom("Ana", "1111", "duel", digits);
    const b = await game.joinRoom(a.code, "Ben", "2222");
    if (a.error || b.error) throw new Error(`setup failed: ${a.error || b.error}`);
    return { code: a.code, A: a.playerId, B: b.playerId, digits };
  }
  const st = (g, id) => game.getState(g.code, id);
  const ok = (out, msg) => T.assert(!out.error, `${msg || "call"} should work, got: ${out.error}`);
  const bad = (out, msg, status) => { T.assert(out.error, `${msg} should be refused`); if (status) T.eq(out.status, status, msg); return out; };
  async function pickBoth(g, sA, sB) {
    ok(await game.pickSecret(g.code, g.A, sA), "A picks");
    ok(await game.pickSecret(g.code, g.B, sB), "B picks");
  }
  // The number that hasn't been cracked yet, per player; helpers to play a round.
  const miss = (g, k) => num(g.digits, [1, 2, 3, 4, 6, 7][k % 6]); // never the two secrets (rotations 0 and 5)
  const sA = (d) => num(d, 0);
  const sB = (d) => num(d, 5);

  for (const digits of [3, 4, 5]) {
    await T.test(`x${digits}: seats, picking, and the round starts only when both have picked`, async () => {
      const g = await mk(digits);
      let s = await st(g, g.A);
      T.eq(s.mode, "duel"); T.eq(s.roundState, "pending"); T.eq(s.duel.ids.join(), [g.A, g.B].join());
      T.eq(s.duel.picked[g.A], false); T.eq(s.duel.picked[g.B], false);
      // Invalid numbers
      for (const v of ["", "0123".slice(0, digits), "1".repeat(digits), "12", "abcd".slice(0, digits), "1234567"]) bad(await game.pickSecret(g.code, g.A, v), `pick "${v}"`);
      ok(await game.pickSecret(g.code, g.A, sA(digits)));
      bad(await game.pickSecret(g.code, g.A, num(digits, 2)), "picking twice");
      s = await st(g, g.A);
      T.eq(s.roundState, "pending"); T.eq(s.duel.mySecret, sA(digits)); T.eq(s.duel.picked[g.A], true); T.eq(s.duel.picked[g.B], false);
      const sBv = await st(g, g.B);
      T.eq(sBv.duel.mySecret, null, "B never gets A's number"); T.assert(!carries(sBv, sA(digits)), "nowhere in B's response");
      bad(await game.submitGuess(g.code, g.A, miss(g, 0)), "guess before both picked");
      bad(await game.submitGuess(g.code, g.B, miss(g, 0)), "guess before both picked (B)");
      ok(await game.pickSecret(g.code, g.B, sB(digits)));
      s = await st(g, g.A);
      T.eq(s.roundState, "active"); T.eq(s.currentPlayerId, g.A, "the creator goes first in round 1");
      T.eq(s.duel.mySecret, sA(digits)); T.assert(!carries(s, sB(digits)), "A never sees B's number");
      const s2 = await st(g, g.B);
      T.eq(s2.duel.mySecret, sB(digits)); T.assert(!carries(s2, sA(digits)), "B never sees A's number");
      T.eq(s2.currentPlayerId, g.A);
    });

    await T.test(`x${digits}: fair ending — first player cracks, second misses on the last turn: first wins`, async () => {
      const g = await mk(digits);
      await pickBoth(g, sA(digits), sB(digits));
      ok(await game.submitGuess(g.code, g.A, miss(g, 0)));
      ok(await game.submitGuess(g.code, g.B, miss(g, 0)), "the same number is fine: it's aimed at a different target");
      const r = await game.submitGuess(g.code, g.A, sB(digits));
      ok(r); T.eq(r.result.stars, digits);
      let s = await st(g, g.B);
      T.eq(s.roundState, "active", "the round is not over yet"); T.eq(s.currentPlayerId, g.B, "B gets one final turn");
      T.eq(s.duel.crackedBy, g.A);
      T.eq(s.duel.numbers, null, "numbers still hidden");
      bad(await game.submitGuess(g.code, g.A, miss(g, 1)), "A can't guess again");
      ok(await game.submitGuess(g.code, g.B, miss(g, 1)), "B's final guess misses");
      s = await st(g, g.B);
      T.eq(s.roundState, "ended"); T.eq(s.winner.id, g.A); T.eq(s.winner.tries, 2); T.eq(s.draw, false);
      T.eq(s.duel.numbers[g.A], sA(digits)); T.eq(s.duel.numbers[g.B], sB(digits), "both numbers revealed to both");
      const sa = await st(g, g.A);
      T.eq(JSON.stringify(sa.duel.numbers), JSON.stringify(s.duel.numbers));
      T.eq(sa.scoreboard.find((e) => e.id === g.A).wins, 1); T.eq(sa.scoreboard.find((e) => e.id === g.B).wins, 0);
      const row = sa.rounds[0];
      T.eq(row.round, 1); T.eq(row.winnerName, "Ana"); T.eq(row.totalTries, 4); T.eq(row.duel.draw, false);
      T.eq(row.duel.numbers.map((n) => `${n.name}:${n.secret}`).join(), `Ana:${sA(digits)},Ben:${sB(digits)}`);
      const d = (await game.getReplay(g.code, g.B, 1)).details;
      T.eq(d.outcome, "win"); T.eq(d.guesses.length, 4); T.eq(d.winners[0].id, g.A);
      T.eq(d.secrets.map((x) => x.secret).join(), [sA(digits), sB(digits)].join());
      T.eq(d.guesses.map((x) => x.playerId).join(), [g.A, g.B, g.A, g.B].join(), "alternating order");
      d.guesses.forEach((x) => {
        const target = d.secrets.find((y) => y.id === x.target).secret;
        T.assert(x.target !== x.playerId, "aimed at the other player");
        const ref = refCheckGuess(target, x.guess);
        T.eq(x.stars, ref.stars); T.eq(x.dots, ref.dots);
      });
    });

    await T.test(`x${digits}: fair ending — the second player cracks it first and wins at once`, async () => {
      const g = await mk(digits);
      await pickBoth(g, sA(digits), sB(digits));
      ok(await game.submitGuess(g.code, g.A, miss(g, 0)));
      const r = await game.submitGuess(g.code, g.B, sA(digits));
      ok(r); T.eq(r.result.stars, digits);
      const s = await st(g, g.A);
      T.eq(s.roundState, "ended"); T.eq(s.winner.id, g.B); T.eq(s.winner.tries, 1); T.eq(s.draw, false);
      T.eq(s.scoreboard.find((e) => e.id === g.B).wins, 1);
      bad(await game.submitGuess(g.code, g.A, miss(g, 1)), "nothing more to guess");
    });

    await T.test(`x${digits}: fair ending — both crack it on the same turn: a draw`, async () => {
      const g = await mk(digits);
      await pickBoth(g, sA(digits), sB(digits));
      ok(await game.submitGuess(g.code, g.A, sB(digits)));
      ok(await game.submitGuess(g.code, g.B, sA(digits)));
      const s = await st(g, g.A);
      T.eq(s.roundState, "ended"); T.eq(s.winner, null); T.eq(s.draw, true);
      T.assert(s.scoreboard.every((e) => e.wins === 0), "a draw counts for neither");
      T.eq(s.rounds[0].winnerName, null); T.eq(s.rounds[0].duel.draw, true); T.eq(s.rounds[0].totalTries, 2);
      const d = (await game.getReplay(g.code, g.A, 1)).details;
      T.eq(d.outcome, "draw"); T.eq(d.winners.length, 0);
      T.eq(d.guesses.filter((x) => x.stars === digits).length, 2, "both cracking guesses are saved");
    });

    await T.test(`x${digits}: several turns, then who goes first alternates every round`, async () => {
      const g = await mk(digits);
      const firsts = [];
      for (let round = 1; round <= 4; round++) {
        await pickBoth(g, sA(digits), sB(digits));
        const s = await st(g, g.A);
        T.eq(s.round, round);
        firsts.push(s.currentPlayerId === g.A ? "A" : "B");
        const first = s.currentPlayerId, second = first === g.A ? g.B : g.A;
        const cur = (x) => (x === g.A ? sB(digits) : sA(digits)); // the number x is trying to crack
        // three misses each, then the first player cracks and the second misses
        for (let i = 0; i < 3; i++) { ok(await game.submitGuess(g.code, first, miss(g, i))); ok(await game.submitGuess(g.code, second, miss(g, i))); }
        ok(await game.submitGuess(g.code, first, cur(first)));
        ok(await game.submitGuess(g.code, second, miss(g, 3)));
        const e = await st(g, g.A);
        T.eq(e.roundState, "ended"); T.eq(e.winner.id, first); T.eq(e.winner.tries, 4);
        ok(await game.newRound(g.code, round % 2 ? g.B : g.A), "either player can start the next round");
        const p = await st(g, g.B);
        T.eq(p.roundState, "pending"); T.eq(p.round, round + 1); T.eq(p.duel.numbers, null);
        T.assert(p.players.every((x) => x.history.length === 0), "guess lists cleared");
        T.eq(p.duel.mySecret, null, "no number picked yet");
        const { rounds, ...live } = p; // (finished rounds legitimately list their numbers)
        T.assert(!carries(live, sA(digits)) && !carries(live, sB(digits)), "old numbers gone from the live round");
      }
      T.eq(firsts.join(""), "ABAB");
    });
  }

  await T.test("guess rules: not your turn, repeats only count against your own guesses, bad formats, double taps", async () => {
    const g = await mk(4);
    await pickBoth(g, "1234", "5678");
    bad(await game.submitGuess(g.code, g.B, "1357"), "B out of turn");
    for (const v of ["", "0123", "1123", "123", "12345", "12a4"]) bad(await game.submitGuess(g.code, g.A, v), `guess "${v}"`);
    ok(await game.submitGuess(g.code, g.A, "1357"));
    ok(await game.submitGuess(g.code, g.B, "1357"), "B may guess what A guessed");
    const dup = bad(await game.submitGuess(g.code, g.A, "1357"), "A repeating their own guess");
    T.assert(/already tried/i.test(dup.error));
    // Double tap: two identical requests at once record one guess.
    const [x, y] = await Promise.all([game.submitGuess(g.code, g.A, "2468"), game.submitGuess(g.code, g.A, "2468")]);
    T.assert(!!x.error !== !!y.error, "exactly one of the two went through");
    const s = await st(g, g.A);
    T.eq(s.players.find((p) => p.id === g.A).history.length, 2);
    T.eq(s.currentPlayerId, g.B);
  });

  await T.test("guesses are recorded in the order they were made (times strictly increase)", async () => {
    const g = await mk(4);
    await pickBoth(g, "1234", "5678");
    for (let i = 0; i < 5; i++) { ok(await game.submitGuess(g.code, g.A, num(4, [1, 2, 3, 5, 6][i]))); ok(await game.submitGuess(g.code, g.B, num(4, [1, 2, 3, 5, 6][i]))); }
    const s = await st(g, g.A);
    const ats = s.players.flatMap((p) => p.history.map((h) => h.at)).sort((a, b) => a - b);
    T.assert(ats.every((t, i) => i === 0 || t > ats[i - 1]), "no ties");
  });

  await T.test("simultaneous picks always start the round exactly once", async () => {
    for (let i = 0; i < 25; i++) {
      const a = await game.createRoom("Ana", "1111", "duel", 4);
      const b = await game.joinRoom(a.code, "Ben", "1111");
      const [x, y] = await Promise.all([game.pickSecret(a.code, a.playerId, "1234"), game.pickSecret(a.code, b.playerId, "5678")]);
      T.assert(!x.error && !y.error);
      const s = await game.getState(a.code, a.playerId);
      T.eq(s.roundState, "active", `round ${i} started`);
      T.eq(s.currentPlayerId, a.playerId);
    }
  });

  await T.test("the opponent's number is never in any response before the round ends (every state, every viewer)", async () => {
    const g = await mk(4);
    const viewers = [g.A, g.B, { id: g.A, token: "nope" }, { id: "stranger", token: "x" }];
    const others = { [g.A]: "1234", [g.B]: "5678" }; // each player's own number
    // `crackedOwner`: once someone's number has been cracked, the cracking guess (public, like every guess)
    // is that number — it's the guesser's own input, not something the server sent.
    const check = async (label, crackedOwner) => {
      for (const v of viewers) {
        const s = await game.getState(g.code, v);
        const vid = typeof v === "string" ? v : null;
        for (const [owner, n] of Object.entries(others)) {
          if (owner === vid || owner === crackedOwner) continue; // your own number is yours to see
          T.assert(!carries(s, n), `${label}: ${JSON.stringify(v).slice(0, 12)} must not see ${owner === g.A ? "A" : "B"}'s number`);
        }
      }
    };
    await check("before any pick");
    await game.pickSecret(g.code, g.A, "1234"); await check("A picked");
    await game.pickSecret(g.code, g.B, "5678"); await check("both picked");
    await game.submitGuess(g.code, g.A, "1357"); await check("a guess in");
    await game.submitGuess(g.code, g.B, "2468"); await check("both guessed");
    await game.submitGuess(g.code, g.A, "5678"); await check("first player cracked (final turn)", g.B);
    // The live-round replay is refused in every state so far.
    for (const v of [g.A, g.B]) { const r = await game.getReplay(g.code, v, 1); T.assert(r.error && !carries(r, "1234") && !carries(r, "5678"), "no replay of a live round"); }
    await game.submitGuess(g.code, g.B, "1357");
    const done = await st(g, g.B);
    T.eq(done.duel.numbers[g.A], "1234"); T.eq(done.duel.numbers[g.B], "5678");
  });

  await T.test("End round: either player, with both numbers revealed and nobody scoring; only while a round is live", async () => {
    const g = await mk(4);
    bad(await game.endRound(g.code, g.A), "no round to end while picking");
    await pickBoth(g, "1234", "5678");
    ok(await game.submitGuess(g.code, g.A, "1357"));
    ok(await game.endRound(g.code, g.B), "the second player can end it too");
    const s = await st(g, g.A);
    T.eq(s.roundState, "ended"); T.eq(s.winner, null); T.eq(s.draw, false);
    T.eq(s.duel.numbers[g.A], "1234"); T.eq(s.duel.numbers[g.B], "5678");
    T.assert(s.scoreboard.every((e) => e.wins === 0));
    T.eq(s.rounds.length, 1); T.eq(s.rounds[0].winnerName, null);
    T.eq((await game.getReplay(g.code, g.A, 1)).details.outcome, "ended");
    bad(await game.endRound(g.code, g.A), "ending an ended round");
    T.eq((await st(g, g.A)).rounds.length, 1, "no double recording");
    bad(await game.newRound(g.code, "nobody"), "not a player");
  });

  await T.test("next round: only once the round has ended", async () => {
    const g = await mk(4);
    bad(await game.newRound(g.code, g.A), "while picking");
    await pickBoth(g, "1234", "5678");
    bad(await game.newRound(g.code, g.A), "while playing");
    ok(await game.endRound(g.code, g.A));
    const [x, y] = await Promise.all([game.newRound(g.code, g.A), game.newRound(g.code, g.B)]);
    T.assert(!x.error && !y.error);
    T.eq((await st(g, g.A)).round, 2, "two taps start one round");
  });

  await T.test("a third person is refused; the two players can still rejoin with their PIN", async () => {
    const g = await mk(4);
    const third = await game.joinRoom(g.code, "Cleo", "3333");
    T.eq(third.error, "This duel is full.");
    // Many at once: nobody gets in.
    const many = await Promise.all(["X1", "X2", "X3", "X4"].map((n) => game.joinRoom(g.code, n, "1111")));
    T.assert(many.every((m) => m.error === "This duel is full."));
    const s = await st(g, g.A);
    T.eq(s.players.length, 2);
    const again = await game.rejoinRoom(g.code, "Ben", "2222");
    T.assert(again.token && again.playerId === g.B, "rejoin works");
    bad(await game.rejoinRoom(g.code, "Ben", "0000"), "wrong PIN");
    bad(await game.rejoinRoom(g.code, "Cleo", "3333"), "not in this duel");
    T.eq((await game.joinRoom(g.code, "Ana", "1111")).error, "This duel is full.");
  });

  await T.test("two people racing for the second seat: exactly one gets it", async () => {
    for (let i = 0; i < 15; i++) {
      const a = await game.createRoom("Ana", "1111", "duel", 4);
      const res = await Promise.all(["B1", "B2", "B3"].map((n) => game.joinRoom(a.code, n, "1111")));
      T.eq(res.filter((r) => !r.error).length, 1, `attempt ${i}`);
      const s = await game.getState(a.code, a.playerId);
      T.eq(s.players.length, 2);
    }
  });

  await T.test("waiting for an opponent: no picking, guessing or new rounds until someone joins", async () => {
    const a = await game.createRoom("Ana", "1111", "duel", 4);
    bad(await game.pickSecret(a.code, a.playerId, "1234"), "pick with nobody there");
    bad(await game.submitGuess(a.code, a.playerId, "1234"), "guess with nobody there");
    const s = await game.getState(a.code, a.playerId);
    T.eq(s.duel.ids[1], null); T.eq(s.roundState, "pending");
  });

  await T.test("a player who leaves: the game waits; End round / End game still work; coming back resumes", async () => {
    const g = await mk(4);
    await pickBoth(g, "1234", "5678");
    ok(await game.submitGuess(g.code, g.A, "1357"));
    ok(await game.leaveGame(g.code, g.B), "B leaves on B's turn");
    let s = await st(g, g.A);
    T.eq(s.duel.awayId, g.B); T.eq(s.currentPlayerId, g.B, "the turn stays with the player who left");
    T.eq(s.players.find((p) => p.id === g.B).leaveReason, "left");
    const wait = bad(await game.submitGuess(g.code, g.A, "2468"), "A can't play while B is away");
    T.assert(/left the duel/i.test(wait.error) && /Ben/.test(wait.error), wait.error);
    bad(await game.submitGuess(g.code, g.B, "2468"), "B can't act while away", 403);
    bad(await game.skipTurn(g.code, g.A), "no skipping");
    bad(await game.removePlayer(g.code, g.A, g.B), "no removing");
    bad(await game.restorePlayer(g.code, g.A, g.B), "no restoring");
    ok(await game.comeBack(g.code, g.B));
    s = await st(g, g.A);
    T.eq(s.duel.awayId, null); T.eq(s.currentPlayerId, g.B, "still B's turn");
    ok(await game.submitGuess(g.code, g.B, "2468"), "B carries on");
    T.eq((await st(g, g.A)).players.find((p) => p.id === g.A).history.length, 1, "guesses kept");
    // Rejoin with the PIN from another device works too.
    ok(await game.leaveGame(g.code, g.A));
    const back = await game.rejoinRoom(g.code, "Ana", "1111");
    ok(back);
    T.eq((await st(g, g.B)).duel.awayId, null);
  });

  await T.test("leaving while picking or between rounds also pauses; ending the round or game is still possible", async () => {
    const g = await mk(4);
    ok(await game.pickSecret(g.code, g.A, "1234"));
    ok(await game.leaveGame(g.code, g.B));
    bad(await game.pickSecret(g.code, g.A, "1357"), "already picked anyway");
    ok(await game.comeBack(g.code, g.B));
    ok(await game.pickSecret(g.code, g.B, "5678"));
    T.eq((await st(g, g.A)).roundState, "active");
    ok(await game.endRound(g.code, g.A));
    ok(await game.leaveGame(g.code, g.B));
    bad(await game.newRound(g.code, g.A), "no next round while B is away");
    ok(await game.endGame(g.code, g.A), "but the game can be ended");
    T.eq((await st(g, g.A)).gameOver, true);
  });

  await T.test("End game: either player; a live round ends with no winner and is saved; nothing can be played afterwards", async () => {
    const g = await mk(4);
    await pickBoth(g, "1234", "5678");
    ok(await game.submitGuess(g.code, g.A, "1357"));
    bad(await game.endGame(g.code, { id: g.A, token: "x" }), "no token", 401);
    ok(await game.endGame(g.code, g.B));
    const s = await st(g, g.A);
    T.eq(s.gameOver, true); T.eq(s.roundState, "ended"); T.eq(s.winner, null);
    T.eq(s.rounds.length, 1);
    const d = (await game.getReplay(g.code, g.A, 1)).details;
    T.eq(d.outcome, "gameover"); T.eq(d.secrets.length, 2);
    for (const p of [g.A, g.B]) {
      bad(await game.pickSecret(g.code, p, "1357"), "pick after the game"); bad(await game.submitGuess(g.code, p, "1357"), "guess after the game"); bad(await game.newRound(g.code, p), "round after the game");
    }
    T.assert((await game.sendChatMessage(g.code, g.A, { text: "gg" })).ok, "chat");
    const sum = await game.getSummary(g.code, g.B);
    T.eq(sum.gameOver, true); T.eq(sum.roundsPlayed, 1);
    T.eq(sum.awards.find((a) => a.key === "guesses").value, "1 guess");
    ok(await game.endGame(g.code, g.A), "twice is fine");
  });

  await T.test("duel summary: wins, fastest solve and most guesses over two rounds, with a draw counting for neither", async () => {
    const g = await mk(4);
    await pickBoth(g, "1234", "5678");
    ok(await game.submitGuess(g.code, g.A, "5678")); ok(await game.submitGuess(g.code, g.B, "1357")); // A cracks in 1, B misses: A wins
    ok(await game.newRound(g.code, g.A));
    await pickBoth(g, "1234", "5678"); // round 2: B first
    ok(await game.submitGuess(g.code, g.B, "1234")); ok(await game.submitGuess(g.code, g.A, "5678")); // both crack: draw
    const s = await game.getSummary(g.code, g.A);
    T.eq(s.roundsPlayed, 2);
    T.eq(s.standings.find((e) => e.name === "Ana").wins, 1); T.eq(s.standings.find((e) => e.name === "Ben").wins, 0);
    const by = Object.fromEntries(s.awards.map((a) => [a.key, a]));
    T.eq(by.fastest.winners[0].name, "Ana"); T.eq(by.fastest.value, "1 try");
    T.eq(by.wins.winners[0].name, "Ana");
    T.assert(!by.hosted, "no hosting award in a duel");
  });

  await T.test("colors, chat and the Redis cost of a duel poll", async () => {
    const g = await mk(4);
    const s = await st(g, g.A);
    T.eq(s.players.map((p) => p.color).join(), "0,1");
    T.assert((await game.sendChatMessage(g.code, g.B, { presetId: "nice-guess" })).ok);
    T.assert((await st(g, g.A)).chat.length === 1);
    await game.getState(g.code, g.A);
    const start = fake.log.length;
    await game.getState(g.code, g.B);
    T.assert(fake.log.slice(start).length <= 8, `a duel poll is ${fake.log.slice(start).length} commands`);
    T.assert(fake.log.slice(start).every((c) => !["set", "hset", "del", "rpush"].includes(c.cmd)), "and never writes");
  });

  await T.test("every key a duel writes has a 24h expiry", async () => {
    const g = await mk(4);
    await pickBoth(g, "1234", "5678");
    ok(await game.submitGuess(g.code, g.A, "5678")); ok(await game.submitGuess(g.code, g.B, "1357"));
    ok(await game.newRound(g.code, g.A));
    ok(await game.endGame(g.code, g.A));
    const TTL = 60 * 60 * 24;
    const written = new Set(fake.log.filter((c) => ["set", "hset", "hsetnx", "rpush"].includes(c.cmd) && String(c.key).startsWith(`room:${g.code}`)).map((c) => c.key));
    const expiring = new Set(fake.log.filter((c) => (c.cmd === "expire" && Number(c.args[1]) === TTL) || (c.cmd === "set" && c.args.map((v) => String(v).toLowerCase()).includes("ex"))).map((c) => c.key));
    for (const k of written) if (!/chatrate/.test(k)) T.assert(expiring.has(k), `${k} has an expiry`);
    void rawRoom;
  });

  await T.test("the other modes refuse duel-only handling and duel rooms refuse rotating/computer-only actions", async () => {
    const g = await mk(4);
    bad(await game.skipTurn(g.code, g.A), "skip"); bad(await game.removePlayer(g.code, g.A, g.B), "remove"); bad(await game.restorePlayer(g.code, g.A, g.B), "restore");
    const c = await game.createRoom("Zed", "1111", "computer", 4);
    bad(await game.createRoom("X", "1111", "trio", 4), "unknown mode");
    const zs = await game.getState(c.code, c.playerId);
    T.eq(zs.duel, undefined, "no duel data outside duels");
  });
}
