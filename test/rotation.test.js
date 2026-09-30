import {
  createGameWithPlayers, rawRoom, rawOrder, randomValidNumber, startRoundIfNeeded, playRoundToWin,
} from "./helpers.js";

// Independent statement of the rule (not the library's code): hosting goes
// around in join order; the next host is the next ACTIVE player after the
// previous host's place, wrapping around.
function refNext(joinList, active, anchor) {
  const n = joinList.length;
  const i = joinList.indexOf(anchor);
  for (let k = 1; k <= n; k++) {
    const id = joinList[(((i + k) % n) + n) % n];
    if (active.has(id)) return id;
  }
  return null;
}

// Finishes the current round: by a win or by "End round" (whoever holds controls).
async function finishRound(game, fake, T, code, how, viewerId) {
  await startRoundIfNeeded(game, fake, code);
  if (how === "win") return playRoundToWin(game, fake, code, viewerId, T);
  const room = rawRoom(fake, code);
  const out = await game.endRound(code, room.controlsId);
  T.assert(!out.error, `endRound: ${out.error}`);
  return null;
}

// While a round is live only the host gets its number.
async function assertHostOnlySecret(game, fake, T, code, everyone) {
  const room = rawRoom(fake, code);
  for (const p of everyone) {
    const s = await game.getState(code, p.id);
    if (p.id === room.hostId && room.roundState === "active") T.eq(s.secret, room.secret, `${p.name} (host) should see this round's number`);
    else T.eq(s.secret, null, `${p.name} must not receive the number (round ${room.round})`);
    if (room.roundState === "active") T.assert(s.currentPlayerId !== room.hostId, "the host is never in the turn order");
  }
}

export default async function run({ game, fake, T }) {
  T.suite("Hosting rotation (rotating mode)");

  for (const digits of [3, 4, 5]) {
    for (const count of [2, 4, 6]) {
      await T.test(`${digits} digits, ${count} players: hosting follows join order and wraps (2+ full cycles, wins and End round mixed)`, async () => {
        const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits, count });
        const joinList = players.map((p) => p.id);
        const active = new Set(joinList);
        let expected = joinList[0];
        const hosts = [];
        const rounds = count * 2 + 1;
        for (let round = 0; round < rounds; round++) {
          const room = rawRoom(fake, code);
          T.eq(room.hostId, expected, `round ${round + 1}: host should be ${expected}`);
          hosts.push(room.hostId);
          await startRoundIfNeeded(game, fake, code);
          await assertHostOnlySecret(game, fake, T, code, players);
          const how = round % 3 === 2 ? "end" : "win";
          const res = await finishRound(game, fake, T, code, how, players[0].id);
          if (res) {
            const scored = await game.getState(code, players[0].id);
            T.assert(scored.scoreboard.find((e) => e.id === res.winnerId).wins > 0, "the winner still gets the win");
          }
          expected = refNext(joinList, active, expected);
          const after = rawRoom(fake, code);
          T.eq(after.hostId, expected, `after round ${round + 1}: hosting should move to the next player in join order`);
          T.eq(after.roundState, "pending", "next round waits for the host's number");
          T.eq(after.secret, null, "no number is held between rounds");
          for (const p of players) T.eq((await game.getState(code, p.id)).secret, null, "no secret between rounds");
        }
        T.eq(new Set(hosts).size, count, "everyone hosted");
        for (let i = 0; i < hosts.length; i++) T.eq(hosts[i], joinList[i % count], `round ${i + 1} host is player ${(i % count) + 1} in join order`);
      });
    }
  }

  await T.test("winning does not make you host: the last player in join order wins round 1 and still only hosts in round 4", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 4 });
    const D = players[3];
    await startRoundIfNeeded(game, fake, code); // A hosts
    const secret = rawRoom(fake, code).secret;
    const seenGuesses = new Set([secret]);
    for (let g = 0; g < 8; g++) {
      const s = await game.getState(code, players[0].id);
      if (s.currentPlayerId === D.id) break;
      const bad = randomValidNumber(4, seenGuesses);
      seenGuesses.add(bad);
      await game.submitGuess(code, s.currentPlayerId, bad);
    }
    const win = await game.submitGuess(code, D.id, secret);
    T.assert(win.won, "D wins round 1");
    T.eq(rawRoom(fake, code).hostId, players[1].id, "round 2 host is B — not the winner D");
    await finishRound(game, fake, T, code, "end", D.id);
    T.eq(rawRoom(fake, code).hostId, players[2].id, "round 3 host is C");
    await finishRound(game, fake, T, code, "end", D.id);
    T.eq(rawRoom(fake, code).hostId, D.id, "round 4 host is D — because the rotation reached them");
    const st = await game.getState(code, D.id);
    T.assert(st.scoreboard.find((e) => e.id === D.id).wins === 1, "D keeps the win on the scoreboard");
  });

  await T.test("a late joiner is added at the end, hosts once when the rotation reaches them, and never twice in a row", async () => {
    for (const count of [2, 4]) {
      const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count });
      const joinList = players.map((p) => p.id);
      const active = new Set(joinList);
      let expected = joinList[0];
      const hosts = [];
      let late = null;
      for (let round = 0; round < count * 3 + 2; round++) {
        if (round === 2) {
          const j = await game.joinRoom(code, "Zed", "2222");
          late = { id: j.playerId, name: "Zed" };
          joinList.push(late.id);
          active.add(late.id);
        }
        const room = rawRoom(fake, code);
        T.eq(room.hostId, expected, `round ${round + 1} host`);
        hosts.push(room.hostId);
        await finishRound(game, fake, T, code, round % 2 ? "win" : "end", players[0].id);
        expected = refNext(joinList, active, expected);
      }
      T.assert(hosts.includes(late.id), "the late joiner hosts");
      for (let i = 1; i < hosts.length; i++) T.assert(hosts[i] !== hosts[i - 1], "nobody hosts twice in a row");
      const firstLate = hosts.indexOf(late.id);
      T.eq(hosts[firstLate - 1], joinList[count - 1], "the late joiner follows the last original player");
      T.eq(hosts.slice(firstLate, firstLate + count + 1).filter((h) => h === late.id).length, 1, "exactly once per lap");
    }
  });

  await T.test("people who leave and come back keep their place; people away when their turn comes are skipped", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 5 });
    const [A, B, C, D, E] = players;
    await startRoundIfNeeded(game, fake, code);
    T.assert(!(await game.leaveGame(code, C.id)).error, "C leaves during round 1");
    await finishRound(game, fake, T, code, "end", A.id);
    T.eq(rawRoom(fake, code).hostId, B.id, "B hosts round 2");
    await finishRound(game, fake, T, code, "end", A.id);
    T.eq(rawRoom(fake, code).hostId, D.id, "C is away, so D hosts round 3");
    T.assert(!(await game.comeBack(code, C.id)).error, "C comes back");
    await finishRound(game, fake, T, code, "win", A.id);
    T.eq(rawRoom(fake, code).hostId, E.id, "E hosts round 4");
    await finishRound(game, fake, T, code, "end", A.id);
    T.eq(rawRoom(fake, code).hostId, A.id, "wraps to A");
    await finishRound(game, fake, T, code, "end", A.id);
    T.eq(rawRoom(fake, code).hostId, B.id, "B");
    await finishRound(game, fake, T, code, "end", A.id);
    T.eq(rawRoom(fake, code).hostId, C.id, "C hosts at their ORIGINAL place, though they're last in the turn order now");
    T.eq(rawOrder(fake, code).filter((id) => id === C.id).length, 1, "C is in the turn order once");
  });

  await T.test("removed players are skipped; a restored player keeps their original place", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 5 });
    const [A, B, C, D, E] = players;
    await startRoundIfNeeded(game, fake, code);
    T.assert(!(await game.removePlayer(code, A.id, C.id)).error, "A removes C");
    await finishRound(game, fake, T, code, "end", A.id);
    T.eq(rawRoom(fake, code).hostId, B.id, "B");
    await finishRound(game, fake, T, code, "end", A.id);
    T.eq(rawRoom(fake, code).hostId, D.id, "removed C is skipped: D");
    T.assert(!(await game.restorePlayer(code, D.id, C.id)).error, "D (host, holds controls) restores C");
    await finishRound(game, fake, T, code, "end", A.id);
    T.eq(rawRoom(fake, code).hostId, E.id, "E");
    await finishRound(game, fake, T, code, "end", A.id);
    T.eq(rawRoom(fake, code).hostId, A.id, "A");
    await finishRound(game, fake, T, code, "end", A.id);
    T.eq(rawRoom(fake, code).hostId, B.id, "B");
    await finishRound(game, fake, T, code, "end", A.id);
    T.eq(rawRoom(fake, code).hostId, C.id, "restored C hosts at their original place (after B)");
  });

  await T.test("after a hostless round the rotation continues from the departed host's place (End round and win)", async () => {
    for (const how of ["end", "win"]) {
      const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 4 });
      const [A, B, C, D] = players;
      await finishRound(game, fake, T, code, "end", A.id);
      await startRoundIfNeeded(game, fake, code);
      T.eq(rawRoom(fake, code).hostId, B.id, "B hosts round 2");
      T.assert(!(await game.leaveGame(code, B.id)).error, "B (host) leaves mid-round");
      T.eq(rawRoom(fake, code).hostId, null, "hostless");
      for (const p of [A, C, D]) T.eq((await game.getState(code, p.id)).secret, null, "nobody holds the number");
      await finishRound(game, fake, T, code, how, A.id);
      T.eq(rawRoom(fake, code).hostId, C.id, `${how}: the next after B (who is away) is C`);
      await finishRound(game, fake, T, code, "end", A.id);
      T.eq(rawRoom(fake, code).hostId, D.id, "D");
      await finishRound(game, fake, T, code, "end", A.id);
      T.eq(rawRoom(fake, code).hostId, A.id, "A (B is still away, skipped)");
    }
  });

  await T.test("host leaves between rounds: the next active player after them hosts immediately", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 4 });
    const [A, B, C, D] = players;
    await finishRound(game, fake, T, code, "end", A.id);
    T.eq(rawRoom(fake, code).hostId, B.id);
    T.assert(!(await game.leaveGame(code, C.id)).error, "C (not host) leaves");
    T.assert(!(await game.leaveGame(code, B.id)).error, "B (pending host) leaves");
    const room = rawRoom(fake, code);
    T.eq(room.hostId, D.id, "C is away, so D hosts");
    T.eq(room.controlsId, D.id, "and holds controls");
    T.eq(room.roundState, "pending", "still waiting for a number");
    T.assert((await game.getState(code, D.id)).isHost, "D sees the host screen");
    const pick = await game.pickSecret(code, D.id, randomValidNumber(4));
    T.assert(!pick.error, `D picks: ${pick.error}`);
    await finishRound(game, fake, T, code, "end", A.id);
    T.eq(rawRoom(fake, code).hostId, A.id, "then A (wrap); B and C are still away");
  });

  await T.test("the host never gets another round's number, and the previous host sees none after their round", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 5, count: 4 });
    let prevHost = null;
    for (let round = 0; round < 8; round++) {
      await startRoundIfNeeded(game, fake, code);
      const room = rawRoom(fake, code);
      await assertHostOnlySecret(game, fake, T, code, players);
      if (prevHost) T.eq((await game.getState(code, prevHost)).secret, null, "the previous host gets nothing");
      prevHost = room.hostId;
      await finishRound(game, fake, T, code, round % 2 ? "end" : "win", players[0].id);
    }
  });
}
