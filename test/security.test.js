import {
  createGameWithPlayers, rawRoom, rawOrder, randomValidNumber, startRoundIfNeeded, setRawPlayer, leaks,
} from "./helpers.js";

function snapshot(fake, code) {
  const out = {};
  for (const [k, e] of fake.store) {
    if (!k.startsWith(`room:${code}`) || k.includes(":chatrate:")) continue;
    out[k] = e.value instanceof Map ? [...e.value] : e.value;
  }
  return JSON.stringify(out);
}

export default async function run({ game, fake, T }) {
  T.suite("Security: identity, tokens and the secret");

  await T.test("tokens are 256-bit random, only their hash is stored, and only the owner ever receives one", async () => {
    const a = await game.createRoom("Ana", "1111", "rotating", 4);
    T.eq(Object.keys(a).sort().join(), "code,playerId,token", "create returns only code, playerId, token");
    T.assert(/^[0-9a-f]{64}$/.test(a.token), "a 256-bit hex token");
    const b = await game.joinRoom(a.code, "Boro", "1111");
    T.eq(Object.keys(b).sort().join(), "playerId,token", "join returns only playerId, token");
    T.assert(a.token !== b.token, "different people, different tokens");
    const again = await game.rejoinRoom(a.code, "Boro", "1111");
    T.eq(Object.keys(again).sort().join(), "playerId,token", "rejoin returns only playerId, token");
    T.assert(again.token !== b.token, "a fresh token per rejoin");
    const raw = fake.store.get(`room:${a.code}:players`).value.get(b.playerId);
    T.assert(!raw.includes(b.token) && !raw.includes(again.token), "the token itself is never stored");
    const rec = JSON.parse(raw);
    T.eq(rec.tokenHashes.length, 2, "two devices, two hashes");
    T.assert(rec.tokenHashes.every((h) => /^[0-9a-f]{64}$/.test(h)), "SHA-256 hashes");
    const keys = [...fake.store.keys()].filter((k) => k.includes(a.code));
    T.assert(!keys.some((k) => k.includes("token")), "no separate token-to-player lookup key exists");
  });

  for (const mode of ["rotating", "computer"]) {
    await T.test(`${mode}: the public player id (and every other credential trick) is never accepted as proof of identity`, async () => {
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: 5 });
      await startRoundIfNeeded(game, fake, code);
      const room = rawRoom(fake, code);
      const host = players.find((p) => p.id === room.hostId) || players[0];
      const controls = players.find((p) => p.id === room.controlsId);
      const s0 = await game.getState(code, players[0].id);
      const current = players.find((p) => p.id === s0.currentPlayerId);
      const attacker = players.find((p) => ![host.id, controls.id, current.id].includes(p.id));
      const removed = players.find((p) => ![host.id, controls.id, current.id, attacker.id].includes(p.id));
      await game.removePlayer(code, controls.id, removed.id);
      const target = attacker;

      const victims = [...new Set([host, controls, current])];
      for (const victim of victims) {
        const creds = {
          "public id as the token": { id: victim.id, token: victim.id },
          "no token": { id: victim.id, token: undefined },
          "empty token": { id: victim.id, token: "" },
          "garbage token": { id: victim.id, token: "not-a-token" },
          "token-shaped garbage": { id: victim.id, token: "a".repeat(64) },
          "someone else's real token": { id: victim.id, token: game.tokenOf(attacker.id) },
          "swapped ids": { id: attacker.id, token: game.tokenOf(victim.id) },
          "token hash from storage": { id: victim.id, token: JSON.parse(fake.store.get(`room:${code}:players`).value.get(victim.id)).tokenHashes[0] },
          "no id at all": { id: undefined, token: game.tokenOf(victim.id) },
        };
        for (const [label, cred] of Object.entries(creds)) {
          const before = snapshot(fake, code);
          const secret = rawRoom(fake, code).secret;
          const attempts = {
            guess: await game.submitGuess(code, cred, randomValidNumber(4, new Set([secret]))),
            pick: await game.pickSecret(code, cred, randomValidNumber(4)),
            skip: await game.skipTurn(code, cred),
            remove: await game.removePlayer(code, cred, target.id),
            restore: await game.restorePlayer(code, cred, removed.id),
            endRound: await game.endRound(code, cred),
            leave: await game.leaveGame(code, cred),
            comeBack: await game.comeBack(code, cred),
            newRound: await game.newRound(code, cred),
            chat: await game.sendChatMessage(code, cred, { text: "hello" }),
            preset: await game.sendChatMessage(code, cred, { presetId: "nice-guess" }),
          };
          for (const [action, res] of Object.entries(attempts)) {
            T.assert(!!res.error, `${mode}: ${action} as ${victim.name} with ${label} must be rejected`);
            if (action !== "comeBack" || label !== "no id at all") T.assert(res.status === 401, `${action}/${label}: expected 401, got ${res.status} (${res.error})`);
            if (secret) T.assert(!JSON.stringify(res).includes(secret), "errors never contain the number");
          }
          T.eq(snapshot(fake, code), before, `${mode}: nothing changed in the database (${label})`);
          const st = await game.getState(code, cred);
          T.eq(st.me, null, `${label}: not signed in`);
          T.eq(st.secret, null, `${label}: no secret`);
          T.assert(!st.isHost && !st.isControlsHolder && !st.isOrganizer, `${label}: no roles`);
          T.eq(st.chat.length, 0, `${label}: no chat`);
        }
      }

      // A removed player's token: read-only.
      const rcred = { id: removed.id, token: game.tokenOf(removed.id) };
      const before = snapshot(fake, code);
      for (const [action, res] of Object.entries({
        guess: await game.submitGuess(code, rcred, randomValidNumber(4)),
        pick: await game.pickSecret(code, rcred, randomValidNumber(4)),
        skip: await game.skipTurn(code, rcred),
        remove: await game.removePlayer(code, rcred, target.id),
        restore: await game.restorePlayer(code, rcred, removed.id),
        endRound: await game.endRound(code, rcred),
        leave: await game.leaveGame(code, rcred),
        comeBack: await game.comeBack(code, rcred),
        newRound: await game.newRound(code, rcred),
        chat: await game.sendChatMessage(code, rcred, { text: "hello" }),
      })) T.assert(!!res.error, `a removed player must not be able to ${action}`);
      T.eq(snapshot(fake, code), before, "removed player's attempts changed nothing");
      T.assert((await game.getState(code, rcred)).me.removed, "but they can still read the game");
      T.assert(!!(await game.rejoinRoom(code, removed.name, "1111")).error, "and can't rejoin by themselves");
    });

    await T.test(`${mode}: the token of someone who left can only read, and come back`, async () => {
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: 4 });
      await startRoundIfNeeded(game, fake, code);
      const room = rawRoom(fake, code);
      const P = players.find((p) => p.id !== room.hostId && p.id !== room.controlsId);
      await game.leaveGame(code, P.id);
      const cred = { id: P.id, token: game.tokenOf(P.id) };
      T.assert((await game.getState(code, cred)).me.leaveReason === "left", "can read");
      T.assert(!!(await game.submitGuess(code, cred, randomValidNumber(4))).error, "not guess");
      T.assert(!!(await game.sendChatMessage(code, cred, { text: "x" })).error, "not chat");
      T.assert(!!(await game.leaveGame(code, cred)).error, "not leave again");
      T.assert(!(await game.comeBack(code, cred)).error, "but can come back");
    });
  }

  for (const digits of [3, 4, 5]) {
    for (const mode of ["rotating", "computer"]) {
      await T.test(`${mode}, ${digits} digits: the number reaches only the rotating host, in every round state, for every kind of viewer`, async () => {
        const { code, players } = await createGameWithPlayers(game, { mode, digits, count: 5 });
        const guests = players;
        const allTokens = () => new Set(players.map((p) => game.tokenOf(p.id)));
        const hashes = () => [...fake.store.get(`room:${code}:players`).value.values()].flatMap((raw) => JSON.parse(raw).tokenHashes.concat(JSON.parse(raw).pinHash, JSON.parse(raw).pinSalt));

        async function check(label) {
          const room = rawRoom(fake, code);
          const live = room.secret; // null when nothing is being held
          const viewers = [
            ...guests.map((p) => ({ label: p.name, cred: { id: p.id, token: game.tokenOf(p.id) }, p })),
            { label: "anonymous", cred: { id: undefined, token: undefined } },
            { label: "public id as token", cred: { id: players[0].id, token: players[0].id } },
            { label: "invalid token", cred: { id: players[1].id, token: "f".repeat(64) } },
          ];
          for (const v of viewers) {
            const st = await game.getState(code, v.cred);
            const json = JSON.stringify(st);
            const mayKnow = mode === "rotating" && st.isHost && room.roundState === "active" && !!v.p;
            if (live) {
              const found = leaks(st, live);
              if (mayKnow) T.eq(st.secret, live, `${label}: the host sees this round's number`);
              else T.assert(found.length === 0, `${label}: ${v.label} must not receive the number (${found.join("; ")})`);
            }
            if (!mayKnow) T.eq(st.secret, null, `${label}: ${v.label} has secret=null`);
            for (const t of allTokens()) T.assert(!json.includes(t), `${label}: a token appeared in ${v.label}'s state`);
            for (const h of hashes()) T.assert(!json.includes(h), `${label}: a hash appeared in ${v.label}'s state`);
            T.assert(!/pinHash|pinSalt|tokenHash|nameLower/.test(json), `${label}: private field names in state`);
          }
          // The finished-rounds table only holds finished rounds.
          const st = await game.getState(code, guests[1].id);
          T.assert(st.rounds.length <= room.round - (room.roundState === "active" ? 1 : 0) + 0, "rounds table only has finished rounds");
          if (live && room.roundState === "active") T.assert(!st.rounds.some((r) => r.secret === live && r.round === room.round), "current round isn't in the table");
        }

        await check("start");
        for (let round = 0; round < 3; round++) {
          await startRoundIfNeeded(game, fake, code);
          await check(`round ${round + 1} active`);
          // some guesses (including a duplicate, to see the error)
          const used = new Set([rawRoom(fake, code).secret]);
          for (let g = 0; g < 3; g++) {
            const s = await game.getState(code, players[0].id);
            if (!s.currentPlayerId) break;
            const guess = randomValidNumber(digits, used);
            used.add(guess);
            const out = await game.submitGuess(code, s.currentPlayerId, guess);
            T.assert(!JSON.stringify(out).includes(rawRoom(fake, code).secret), "guess responses don't contain the number");
            const dup = await game.submitGuess(code, s.currentPlayerId, guess);
            T.assert(!JSON.stringify(dup).includes(rawRoom(fake, code).secret), "error responses don't contain the number");
          }
          await check(`round ${round + 1} mid-round`);
          const R = rawRoom(fake, code);
          if (mode === "rotating" && round === 1) {
            await game.leaveGame(code, R.hostId);
            await check(`round ${round + 1} hostless`);
            const inn = players.find((p) => p.id === rawRoom(fake, code).controlsId);
            T.assert(leaks(await game.getState(code, inn.id), R.secret).length === 0, "the stand-in never sees the number");
          }
          const controls = rawRoom(fake, code).controlsId;
          await game.endRound(code, controls);
          await check(`round ${round + 1} ended`);
          if (mode === "computer") await game.newRound(code, players.find((p) => rawOrder(fake, code).includes(p.id)).id);
          await check(`round ${round + 2} start`);
        }
        // The host leaving between rounds hands the seat on without leaking anything.
        if (mode === "rotating") {
          const h = rawRoom(fake, code).hostId;
          await game.leaveGame(code, h);
          await check("host left between rounds");
        }
      });
    }
  }

  await T.test("PIN guessing: at most 5 tries per lockout window, even with parallel requests (60 per hour per name)", async () => {
    const { code } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 2 });
    const pins = Array.from({ length: 300 }, (_, i) => String(2000 + i));
    const results = await Promise.all(pins.map((pin) => game.rejoinRoom(code, "Ana", pin)));
    const checked = results.filter((r) => /wrong pin/i.test(r.error || "") || /too many attempts/i.test(r.error || "") && /5 minutes/.test(r.error)).length;
    const wrong = results.filter((r) => /^Wrong PIN/.test(r.error || "")).length;
    T.assert(wrong <= 4, `at most 4 'Wrong PIN' answers before the lock (got ${wrong})`);
    T.assert(results.filter((r) => /too many/i.test(r.error || "")).length >= 296, "everything else is locked out");
    void checked;
    const right = await game.rejoinRoom(code, "Ana", "1111");
    T.assert(!!right.error && /too many/i.test(right.error), "even the right PIN is refused while locked");
    T.eq(right.status, 429, "with a 429");
    // After the window the counter is gone.
    const ak = `room:${code}:pinfail:${JSON.parse([...fake.store.get(`room:${code}:players`).value.values()][0]).id}`;
    fake.store.get(ak).expiresAt = Date.now() - 1;
    const ok = await game.rejoinRoom(code, "Ana", "1111");
    T.assert(!ok.error, `right PIN works once the lock has run out: ${ok.error}`);
  });

  await T.test("old saved data (a player record without a token hash) can't sign in; rejoining with name + PIN repairs it", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 2 });
    const p = players[1];
    const oldToken = game.tokenOf(p.id);
    setRawPlayer(fake, code, p.id, { tokenHashes: undefined });
    T.eq((await game.getState(code, { id: p.id, token: oldToken })).me, null, "no token hash → not signed in");
    T.eq((await game.getState(code, { id: p.id, token: undefined })).me, null, "id alone → not signed in");
    const r = await game.rejoinRoom(code, p.name, "1111");
    T.assert(!r.error && r.token, "rejoin works");
    T.assert((await game.getState(code, { id: p.id, token: r.token })).me, "and signs in");
  });

  await T.test("a token from one game can't be used in another, and chat messages are always sent as the verified person", async () => {
    const g1 = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 2 });
    const g2 = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 2 });
    const cred = { id: g2.players[0].id, token: game.tokenOf(g1.players[0].id) };
    T.assert(!!(await game.sendChatMessage(g2.code, cred, { text: "x" })).error, "cross-game token rejected");
    const out = await game.sendChatMessage(g1.code, g1.players[1].id, { text: "hi", playerId: g1.players[0].id, name: "Ana" });
    T.eq(out.message.playerId, g1.players[1].id, "sent as the authenticated person, whatever the body says");
  });

  await T.test("rejoining as someone else still needs their PIN", async () => {
    const { code } = await createGameWithPlayers(game, { mode: "rotating", digits: 4, count: 3 });
    const bad = await game.rejoinRoom(code, "Ana", "0000");
    T.assert(!!bad.error && !bad.token && !bad.playerId, "wrong PIN gives no identity");
    const missing = await game.rejoinRoom(code, "Nobody", "1111");
    T.assert(!!missing.error, "unknown names fail");
  });
}
