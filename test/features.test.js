import {
  createGameWithPlayers, rawRoom, rawPlayer, setRawPlayer, randomValidNumber, startRoundIfNeeded, playRoundToWin,
  refCheckGuess,
} from "./helpers.js";
import { computeAwards } from "../lib/summary.js";
import { pickColor, PALETTE_SIZE } from "../lib/colors.js";

const TTL = 60 * 60 * 24;

function detailsOf(fake, code, round) {
  const e = fake.store.get(`room:${code}:rounddetails`);
  const raw = e && e.value.get(String(round));
  return raw ? JSON.parse(raw) : null;
}

// Colors, saved round details, replays, the summary awards and ending the game.
export default async function run({ game, fake, T }) {
  T.suite("Colors");

  await T.test("pickColor: first unused; reuses (least used first) when all are taken", () => {
    T.eq(pickColor([]), 0);
    T.eq(pickColor([0, 1, 3]), 2, "first unused, not the next number");
    T.eq(pickColor([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 0, "all taken: reuse");
    T.eq(pickColor([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0]), 1, "least used first");
    T.eq(pickColor([undefined, null, "x", 99]), 0, "junk is ignored");
    T.eq(PALETTE_SIZE, 10);
  });

  for (const mode of ["rotating", "computer", "duel"]) {
    await T.test(`${mode}: the creator gets color 0 and joiners the first color nobody active has`, async () => {
      const count = mode === "duel" ? 2 : 6;
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count });
      const st = await game.getState(code, players[0].id);
      T.eq(st.players.map((p) => p.color).join(), Array.from({ length: count }, (_, i) => i).join(), "0,1,2,...");
      T.assert(st.players.every((p) => Number.isInteger(p.color) && p.color >= 0 && p.color < PALETTE_SIZE));
    });
  }

  await T.test("more people than colors: colors are reused, still valid", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 8 });
    for (const n of ["Ira", "Jo", "Kai", "Lea"]) await game.joinRoom(code, n, "1111");
    const st = await game.getState(code, players[0].id);
    T.eq(st.players.map((p) => p.color).join(), "0,1,2,3,4,5,6,7,8,9,0,1");
  });

  await T.test("a late joiner takes a color freed by someone who left; the leaver keeps theirs when they return", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 4 });
    await game.leaveGame(code, players[1].id); // color 1 is now free
    const late = await game.joinRoom(code, "Late", "1111");
    let st = await game.getState(code, players[0].id);
    T.eq(st.players.find((p) => p.id === late.playerId).color, 1, "took the free color");
    await game.comeBack(code, players[1].id);
    st = await game.getState(code, players[0].id);
    T.eq(st.players.find((p) => p.id === players[1].id).color, 1, "the leaver kept their own color");
  });

  for (const mode of ["rotating", "computer"]) {
    await T.test(`${mode}: colors survive leave/comeback, rejoin with PIN, remove and restore`, async () => {
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: 5 });
      await startRoundIfNeeded(game, fake, code);
      const room = rawRoom(fake, code);
      const before = Object.fromEntries((await game.getState(code, players[0].id)).players.map((p) => [p.id, p.color]));
      const others = players.filter((p) => p.id !== room.controlsId);
      await game.leaveGame(code, others[0].id);
      await game.comeBack(code, others[0].id);
      await game.leaveGame(code, others[1].id);
      await game.rejoinRoom(code, others[1].name, "1111");
      await game.removePlayer(code, room.controlsId, others[2].id);
      await game.restorePlayer(code, room.controlsId, others[2].id);
      const after = Object.fromEntries((await game.getState(code, players[0].id)).players.map((p) => [p.id, p.color]));
      T.eq(JSON.stringify(after), JSON.stringify(before), "every color unchanged");
    });
  }

  await T.test("games from before colors existed get a stable color from their place in the join order", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    for (const p of players) {
      const rec = rawPlayer(fake, code, p.id);
      delete rec.color;
      fake.store.get(`room:${code}:players`).value.set(p.id, JSON.stringify(rec));
    }
    const a = (await game.getState(code, players[0].id)).players.map((p) => p.color);
    const b = (await game.getState(code, players[0].id)).players.map((p) => p.color);
    T.eq(a.join(), "0,1,2");
    T.eq(b.join(), a.join(), "the same on every poll");
  });

  T.suite("Round details (replays)");

  for (const mode of ["rotating", "computer"]) {
    for (const digits of [3, 4, 5]) {
      await T.test(`${mode} x ${digits}: a won round saves every guess in order with the right pegs, colors, host and winner`, async () => {
        const { code, players } = await createGameWithPlayers(game, { mode, digits, count: 3 });
        const hostBefore = mode === "rotating" ? rawRoom(fake, code).hostId : null;
        const roundNo = rawRoom(fake, code).round;
        const { secret, guesses, winnerId } = await playRoundToWin(game, fake, code, players[0].id, T);
        const d = detailsOf(fake, code, roundNo);
        T.assert(d, "details saved");
        T.eq(d.round, roundNo); T.eq(d.mode, mode); T.eq(d.digits, digits); T.eq(d.outcome, "win"); T.eq(d.secret, secret);
        T.eq(d.secrets, null);
        T.eq(d.guesses.length, guesses.length);
        d.guesses.forEach((g, i) => {
          T.eq(g.n, i + 1, "numbered in order");
          T.eq(g.playerId, guesses[i].playerId, "same player, same order");
          T.eq(g.guess, guesses[i].guess);
          const ref = refCheckGuess(secret, g.guess);
          T.eq(g.stars, ref.stars); T.eq(g.dots, ref.dots);
          T.eq(g.name, players.find((p) => p.id === g.playerId).name);
          T.assert(Number.isInteger(g.color));
          if (i > 0) T.assert(g.at > d.guesses[i - 1].at, "strictly increasing times");
        });
        T.eq(d.winners.length, 1);
        T.eq(d.winners[0].id, winnerId);
        T.eq(d.winners[0].tries, d.guesses.filter((g) => g.playerId === winnerId).length);
        if (mode === "rotating") { T.eq(d.host.id, hostBefore); T.eq(d.host.left, false); } else T.eq(d.host, null);
      });
    }

    await T.test(`${mode}: "End round" saves the details with no winner and the number`, async () => {
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: 3 });
      await startRoundIfNeeded(game, fake, code);
      const room = rawRoom(fake, code);
      const st = await game.getState(code, players[0].id);
      await game.submitGuess(code, st.currentPlayerId, room.secret === "1357" ? "2468" : "1357");
      await game.endRound(code, room.controlsId);
      const d = detailsOf(fake, code, room.round);
      T.eq(d.outcome, "ended"); T.eq(d.winners.length, 0); T.eq(d.secret, room.secret); T.eq(d.guesses.length, 1);
    });

    await T.test(`${mode}: a round with no guesses at all saves an empty guess list`, async () => {
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: 3 });
      await startRoundIfNeeded(game, fake, code);
      const room = rawRoom(fake, code);
      await game.endRound(code, room.controlsId);
      const d = detailsOf(fake, code, room.round);
      T.eq(d.guesses.length, 0);
      const out = await game.getReplay(code, players[0].id, room.round);
      T.eq(out.available, true);
    });
  }

  await T.test("rotating: a hostless round (host left mid-round) records the departed host", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 3 });
    await startRoundIfNeeded(game, fake, code);
    const room = rawRoom(fake, code);
    await game.leaveGame(code, room.hostId);
    const after = rawRoom(fake, code);
    T.eq(after.hostId, null, "hostless");
    await game.endRound(code, after.controlsId);
    const d = detailsOf(fake, code, room.round);
    T.eq(d.host.id, room.hostId); T.eq(d.host.left, true);
  });

  await T.test("details use the same 24h expiry as everything else", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 2 });
    await playRoundToWin(game, fake, code, players[0].id, T);
    const cmds = fake.log.filter((c) => c.key === `room:${code}:rounddetails`);
    T.assert(cmds.some((c) => c.cmd === "hset"), "written to its own key");
    T.assert(cmds.some((c) => c.cmd === "expire" && Number(c.args[1]) === TTL), "24h expiry set");
  });

  await T.test("the state poll never carries round details", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    await playRoundToWin(game, fake, code, players[0].id, T);
    const start = fake.log.length;
    const st = await game.getState(code, players[0].id);
    T.assert(!fake.log.slice(start).some((c) => String(c.key).includes("rounddetails")), "poll doesn't touch the details key");
    T.assert(!("guesses" in (st.rounds[0] || {})), "rounds entries stay small");
    T.eq(Object.keys(st.rounds[0]).sort().join(), "round,secret,totalTries,winnerName", "rounds summary entries unchanged");
  });

  T.suite("Replay route: only finished rounds");

  for (const mode of ["rotating", "computer"]) {
    await T.test(`${mode}: the current round and any not-yet-finished or missing round never return a number`, async () => {
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: 3 });
      const viewer = players[1].id;
      for (let round = 0; round < 3; round++) {
        await startRoundIfNeeded(game, fake, code);
        const room = rawRoom(fake, code);
        const live = room.secret;
        const host = mode === "rotating" ? room.hostId : null;
        for (const who of [viewer, host || players[0].id]) {
          for (const n of [room.round, room.round + 1, room.round + 5, 0, -1, "abc", 1.5, "", null, "1e1"]) {
            const out = await game.getReplay(code, who, n);
            if (n === room.round && room.roundState === "active") T.assert(out.error, `round ${n} is live: must error`);
            if (out.error) T.assert(!JSON.stringify(out).includes(live), "an error never carries the number");
            else T.assert(out.details && out.details.secret !== live && !out.details.guesses.some((g) => g.guess === live), "only other, finished rounds");
          }
        }
        const err = await game.getReplay(code, viewer, room.round);
        T.assert(err.error && err.available === undefined, "the live round gives an error");
        T.eq(err.status, 403);
        await playRoundToWin(game, fake, code, viewer, T);
        if (mode === "computer") await game.newRound(code, players[0].id);
      }
    });

    await T.test(`${mode}: a finished round replays; earlier ones stay available`, async () => {
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: 3 });
      const secrets = [];
      for (let i = 0; i < 3; i++) {
        const r = await playRoundToWin(game, fake, code, players[0].id, T);
        secrets.push(r.secret);
        if (mode === "computer" && i < 2) await game.newRound(code, players[0].id);
        if (mode === "rotating") { /* next pending */ }
      }
      for (let i = 1; i <= 3; i++) {
        const out = await game.getReplay(code, players[2].id, i);
        T.eq(out.available, true, `round ${i}`);
        T.eq(out.details.secret, secrets[i - 1]);
      }
    });
  }

  await T.test("a round finished before details were saved says so instead of erroring", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 2 });
    await playRoundToWin(game, fake, code, players[0].id, T);
    fake.store.delete(`room:${code}:rounddetails`);
    const out = await game.getReplay(code, players[0].id, 1);
    T.eq(out.error, undefined); T.eq(out.available, false);
  });

  await T.test("replays need a valid token from someone in this game", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    await playRoundToWin(game, fake, code, players[0].id, T);
    const other = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 2 });
    const bads = [
      ["no id, no token", { id: "", token: "" }],
      ["no token", { id: players[0].id, token: undefined }],
      ["garbage token", { id: players[0].id, token: "x".repeat(64) }],
      ["another player's public id as the token", { id: players[0].id, token: players[1].id }],
      ["someone else's real token", { id: players[0].id, token: game.tokenOf(players[1].id) }],
      ["a token from a different game", { id: other.players[0].id, token: game.tokenOf(other.players[0].id) }],
    ];
    for (const [label, who] of bads) {
      for (const fn of ["getReplay", "getSummary"]) {
        const out = fn === "getReplay" ? await game.getReplay(code, who, 1) : await game.getSummary(code, who);
        T.eq(out.status, 401, `${fn}: ${label}`);
        T.assert(!out.details && !out.awards, "and nothing is returned");
      }
    }
    // People who left or were removed can still read (like the state), but not act.
    await game.leaveGame(code, players[1].id);
    const away = await game.getReplay(code, players[1].id, 1);
    T.eq(away.available, true, "an away player can read replays");
    T.assert(!(await game.getSummary(code, players[1].id)).error, "and the summary");
    await game.removePlayer(code, rawRoom(fake, code).controlsId, players[2].id);
    T.eq((await game.getReplay(code, players[2].id, 1)).available, true, "a removed player can read too");
  });

  T.suite("Summary awards");

  await T.test("computeAwards: ties share; missing awards are left out; closest miss tie-break", () => {
    const who = (id) => ({ id, name: id, color: 0 });
    const G = (playerId, guess, stars, dots, at) => ({ playerId, guess, stars, dots, at });
    const details = [
      { round: 1, digits: 4, outcome: "win", host: { id: "h" }, winners: [{ id: "a", tries: 2 }], guesses: [G("a", "1111", 1, 0, 1), G("b", "1112", 3, 0, 2), G("a", "1234", 4, 0, 3)] },
      { round: 2, digits: 4, outcome: "win", host: { id: "h" }, winners: [{ id: "b", tries: 2 }], guesses: [G("a", "2222", 3, 0, 5), G("b", "2223", 2, 2, 6), G("b", "2234", 4, 0, 7)] },
    ];
    const sb = [{ id: "a", wins: 1 }, { id: "b", wins: 1 }, { id: "h", wins: 0 }];
    const awards = computeAwards({ details, scoreboard: sb, mode: "rotating", who });
    const by = Object.fromEntries(awards.map((a) => [a.key, a]));
    T.eq(by.fastest.winners.map((w) => w.id).sort().join(), "a,b", "tie shares Fastest solve");
    T.eq(by.fastest.value, "2 tries");
    T.eq(by.wins.winners.map((w) => w.id).sort().join(), "a,b", "tie shares Most wins");
    T.eq(by.closest.winners[0].id, "b", "3 stars, earliest guess wins the tie");
    T.eq(by.closest.guess, "1112");
    T.eq(by.dots.winners[0].id, "b"); T.eq(by.dots.value, "2 dots");
    T.eq(by.guesses.winners.map((w) => w.id).sort().join(), "a,b", "3 guesses each: shared");
    T.eq(by.hosted.winners[0].id, "h"); T.eq(by.hosted.value, "2 rounds");
    T.eq(computeAwards({ details, scoreboard: sb, mode: "computer", who }).some((a) => a.key === "hosted"), false, "no hosting award outside rotating");

    // Closest miss: more dots beats fewer at equal stars.
    const d2 = [{ round: 1, digits: 5, outcome: "ended", winners: [], guesses: [G("a", "12345", 3, 0, 1), G("b", "12354", 3, 2, 2)] }];
    T.eq(computeAwards({ details: d2, scoreboard: [], mode: "computer", who }).find((a) => a.key === "closest").winners[0].id, "b");

    // Nobody won, no guesses, no pegs at all: those awards vanish.
    T.eq(computeAwards({ details: [], scoreboard: [{ id: "a", wins: 0 }], mode: "rotating", who }).length, 0, "nothing played");
    const d3 = [{ round: 1, digits: 4, outcome: "ended", winners: [], guesses: [G("a", "1234", 0, 0, 1)] }];
    const keys = computeAwards({ details: d3, scoreboard: [{ id: "a", wins: 0 }], mode: "computer", who }).map((a) => a.key);
    T.eq(keys.join(), "guesses", "only 'Most guesses made' is possible");
  });

  await T.test("rotating: standings, every award, rounds and guesses over a real 3-round game", async () => {
    const a = await game.createRoom("Ana", "1111", "rotating", 4);
    const b = await game.joinRoom(a.code, "Boro", "1111");
    const c = await game.joinRoom(a.code, "Cleo", "1111");
    const code = a.code;
    const ids = { Ana: a.playerId, Boro: b.playerId, Cleo: c.playerId };
    const play = async (hostName, secret, moves) => {
      T.eq((await game.getState(code, ids.Ana)).hostName, hostName);
      T.assert(!(await game.pickSecret(code, ids[hostName], secret)).error);
      for (const [name, g] of moves) {
        const st = await game.getState(code, ids.Ana);
        T.eq(st.currentPlayerId, ids[name], `${name}'s turn`);
        const r = await game.submitGuess(code, ids[name], g);
        T.assert(!r.error, r.error);
      }
    };
    await play("Ana", "1234", [["Boro", "1235"], ["Cleo", "2341"], ["Boro", "1234"]]);
    await play("Boro", "5678", [["Ana", "5679"], ["Cleo", "5678"]]);
    await play("Cleo", "9876", [["Ana", "9871"], ["Boro", "6789"], ["Ana", "9876"]]);
    const s = await game.getSummary(code, ids.Cleo);
    T.eq(s.roundsPlayed, 3); T.eq(s.totalGuesses, 8); T.eq(s.gameOver, false);
    T.eq(s.standings.map((e) => `${e.name}:${e.rank}`).join(), "Cleo:1,Ana:2,Boro:2", "same ranking as the scoreboard");
    T.assert(s.standings.every((e) => Number.isInteger(e.color)));
    const by = Object.fromEntries(s.awards.map((x) => [x.key, x]));
    T.eq(s.awards.map((x) => x.key).join(), "fastest,wins,closest,dots,guesses,hosted");
    T.eq(by.fastest.winners.map((w) => w.name).join(), "Cleo"); T.eq(by.fastest.value, "1 try");
    T.eq(by.wins.winners.map((w) => w.name).sort().join(), "Ana,Boro,Cleo"); T.eq(by.wins.value, "1 win");
    T.eq(by.closest.winners[0].name, "Boro"); T.eq(by.closest.guess, "1235"); T.eq(by.closest.value, "★★★"); T.eq(by.closest.round, 1);
    T.eq(by.dots.winners.map((w) => w.name).sort().join(), "Boro,Cleo"); T.eq(by.dots.value, "4 dots");
    T.eq(by.guesses.winners.map((w) => w.name).sort().join(), "Ana,Boro"); T.eq(by.guesses.value, "3 guesses");
    T.eq(by.hosted.winners.map((w) => w.name).sort().join(), "Ana,Boro,Cleo"); T.eq(by.hosted.value, "1 round");
    const scoreboard = (await game.getState(code, ids.Ana)).scoreboard;
    T.eq(s.standings.map((e) => e.id).join(), scoreboard.map((e) => e.id).join(), "the scoreboard's order");
  });

  await T.test("computer: a game where nobody won leaves out the win-based awards", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    const room = rawRoom(fake, code);
    const st = await game.getState(code, players[0].id);
    const g = room.secret === "1357" ? "2468" : "1357";
    await game.submitGuess(code, st.currentPlayerId, g);
    await game.endRound(code, room.controlsId);
    const s = await game.getSummary(code, players[0].id);
    const keys = s.awards.map((a) => a.key);
    T.assert(!keys.includes("fastest") && !keys.includes("wins") && !keys.includes("hosted"), `awards: ${keys}`);
    T.assert(keys.includes("guesses"));
    T.eq(s.roundsPlayed, 1); T.eq(s.totalGuesses, 1);
  });

  T.suite("End game");

  for (const mode of ["rotating", "computer"]) {
    await T.test(`${mode}: only the ${mode === "rotating" ? "host" : "organizer"} can end the game; everyone else, removed players and strangers cannot`, async () => {
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: 4 });
      await startRoundIfNeeded(game, fake, code);
      const room = rawRoom(fake, code);
      const holder = room.controlsId;
      const others = players.filter((p) => p.id !== holder);
      for (const p of others) T.eq((await game.endGame(code, p.id)).status, 403, `${p.name} may not`);
      T.eq((await game.endGame(code, { id: holder, token: undefined })).status, 401, "no token");
      T.eq((await game.endGame(code, { id: holder, token: others[0].id })).status, 401, "public id as token");
      await game.removePlayer(code, holder, others[2].id);
      T.eq((await game.endGame(code, others[2].id)).status, 403, "removed");
      await game.leaveGame(code, others[1].id);
      T.eq((await game.endGame(code, others[1].id)).status, 403, "away");
      T.assert(!rawRoom(fake, code).gameOver, "nothing happened");
      T.assert(!(await game.endGame(code, holder)).error);
      T.eq(rawRoom(fake, code).gameOver, true);
    });

    await T.test(`${mode}: ending mid-round records the round like End round, then nothing more can be played`, async () => {
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: 3 });
      await startRoundIfNeeded(game, fake, code);
      const room = rawRoom(fake, code);
      const st = await game.getState(code, players[0].id);
      const g = room.secret === "1357" ? "2468" : "1357";
      await game.submitGuess(code, st.currentPlayerId, g);
      T.assert(!(await game.endGame(code, room.controlsId)).error);

      const after = await game.getState(code, players[1].id);
      T.eq(after.gameOver, true);
      T.eq(after.rounds.length, 1); T.eq(after.rounds[0].winnerName, null); T.eq(after.rounds[0].secret, room.secret); T.eq(after.rounds[0].totalTries, 1);
      const d = detailsOf(fake, code, room.round);
      T.eq(d.outcome, "gameover"); T.eq(d.winners.length, 0); T.eq(d.guesses.length, 1);
      T.eq((await game.getReplay(code, players[1].id, room.round)).available, true, "its replay is available");

      // Nothing can be played...
      for (const p of players) {
        T.assert((await game.submitGuess(code, p.id, "2468")).error, "no guesses");
        T.assert((await game.pickSecret(code, p.id, "2468")).error, "no number picking");
        T.assert((await game.newRound(code, p.id)).error, "no new rounds");
      }
      T.assert((await game.joinRoom(code, "Newcomer", "1111")).error, "nobody new can join");
      // ...but chat, replays, the summary and rejoining still work.
      T.assert((await game.sendChatMessage(code, players[1].id, { text: "gg" })).ok, "chat stays open");
      T.assert(!(await game.getSummary(code, players[1].id)).error);
      await game.leaveGame(code, players[2].id);
      T.assert(!(await game.rejoinRoom(code, players[2].name, "1111")).error, "rejoin with PIN still works");
      T.assert(!(await game.endGame(code, rawRoom(fake, code).controlsId)).error, "ending twice is harmless");
      T.eq((await game.getState(code, players[2].id)).rounds.length, 1, "and records nothing twice");
    });

    await T.test(`${mode}: ending between rounds just marks the game over`, async () => {
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: 3 });
      await playRoundToWin(game, fake, code, players[0].id, T);
      const before = (await game.getState(code, players[0].id)).rounds.length;
      const room = rawRoom(fake, code);
      T.assert(!(await game.endGame(code, room.controlsId)).error);
      const st = await game.getState(code, players[0].id);
      T.eq(st.gameOver, true); T.eq(st.rounds.length, before, "no extra round recorded");
    });
  }

  await T.test("rotating: after the game ends the next host cannot pick a number", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 3 });
    await startRoundIfNeeded(game, fake, code);
    const room = rawRoom(fake, code);
    await game.endGame(code, room.hostId);
    const next = rawRoom(fake, code);
    T.assert(next.hostId, "the rotation moved on, as after End round");
    const out = await game.pickSecret(code, next.hostId, "1357");
    T.assert(out.error, "but picking is refused");
  });

  await T.test("rotating: a stand-in holding the controls after the host left can end the game", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 3 });
    await startRoundIfNeeded(game, fake, code);
    const room = rawRoom(fake, code);
    await game.leaveGame(code, room.hostId);
    const standIn = rawRoom(fake, code).controlsId;
    T.assert(standIn && standIn !== room.hostId);
    T.assert(!(await game.endGame(code, standIn)).error);
    T.eq(rawRoom(fake, code).gameOver, true);
    T.eq(detailsOf(fake, code, room.round).host.left, true);
  });

  await T.test("everything the new features write is in keys that carry a 24h expiry", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    await playRoundToWin(game, fake, code, players[0].id, T);
    await game.newRound(code, players[0].id);
    await game.endGame(code, rawRoom(fake, code).controlsId);
    const written = new Set(fake.log.filter((c) => ["set", "hset", "hsetnx", "rpush"].includes(c.cmd) && String(c.key).startsWith(`room:${code}`)).map((c) => c.key));
    const expiring = new Set(fake.log.filter((c) => (c.cmd === "expire" && Number(c.args[1]) === TTL) || (c.cmd === "set" && c.args.map((v) => String(v).toLowerCase()).includes("ex"))).map((c) => c.key));
    for (const k of written) if (!/chatrate|back:/.test(k)) T.assert(expiring.has(k), `${k} has an expiry`);
  });
}
