import { createGameWithPlayers, rawRoom, rawPlayer, randomValidNumber } from "./helpers.js";
import { CHAT_PRESETS } from "../lib/chatPresets.js";

const TTL = 60 * 60 * 24;
const chatKey = (code) => `room:${code}:chat`;
const NUL = String.fromCharCode(0);

// The rate limit is per person per 10 seconds, so tests that send a lot clear
// the counters between bursts instead of waiting.
function clearRate(fake) {
  for (const k of [...fake.store.keys()]) if (k.includes(":chatrate:")) fake.store.delete(k);
}

function storedChat(fake, code) {
  const e = fake.store.get(chatKey(code));
  return e ? e.value.map((v) => JSON.parse(v)) : [];
}

export default async function run({ game, fake, T }) {
  T.suite("Chat: sending, validation, limits");

  const newGame = (mode = "computer", count = 3) => createGameWithPlayers(game, { mode, digits: 4, count });

  await T.test("a free message is stored and comes back from getState with exactly the documented fields", async () => {
    const { code, players } = await newGame();
    const out = await game.sendChatMessage(code, players[1].id, { text: "hello there" });
    T.assert(!out.error, `should send, got: ${out.error}`);
    const m = out.message;
    T.eq(Object.keys(m).sort().join(","), "at,id,name,playerId,presetId,text", "message fields");
    T.eq(m.playerId, players[1].id);
    T.eq(m.name, "Boro");
    T.eq(m.text, "hello there");
    T.eq(m.presetId, null);
    T.assert(typeof m.id === "string" && m.id.length > 8, "message needs an id");
    T.assert(Math.abs(m.at - Date.now()) < 5000, "message needs a timestamp");
    const s = await game.getState(code, players[0].id);
    T.eq(s.chat.length, 1);
    T.eq(JSON.stringify(s.chat[0]), JSON.stringify(m), "state shows the stored message");
  });

  await T.test("free messages are trimmed; line breaks and control characters become spaces", async () => {
    const { code, players } = await newGame();
    const a = await game.sendChatMessage(code, players[0].id, { text: "   spaced out   " });
    T.eq(a.message.text, "spaced out");
    const b = await game.sendChatMessage(code, players[0].id, { text: `two\nlines\tand${NUL}nul` });
    T.eq(b.message.text, "two lines and nul");
  });

  await T.test("empty, whitespace-only, missing and non-text messages are rejected", async () => {
    const { code, players } = await newGame();
    for (const bad of [undefined, null, "", "   ", "\n\t ", 42, {}, [], true]) {
      const out = await game.sendChatMessage(code, players[0].id, { text: bad });
      T.assert(out.error, `should reject ${JSON.stringify(bad)}`);
    }
    const none = await game.sendChatMessage(code, players[0].id, {});
    T.assert(none.error, "no text and no presetId should be rejected");
    T.eq((await game.getState(code, players[0].id)).chat.length, 0, "nothing should have been stored");
  });

  await T.test("exactly 200 characters is fine; 201 is rejected; counting is by character, not UTF-16 unit", async () => {
    const { code, players } = await newGame();
    const ok = await game.sendChatMessage(code, players[0].id, { text: "a".repeat(200) });
    T.assert(!ok.error, `200 chars should pass, got: ${ok.error}`);
    const tooLong = await game.sendChatMessage(code, players[0].id, { text: "a".repeat(201) });
    T.assert(tooLong.error && /200/.test(tooLong.error), `201 chars should be rejected with a clear error, got: ${tooLong.error}`);
    const emoji = await game.sendChatMessage(code, players[0].id, { text: "😄".repeat(200) });
    T.assert(!emoji.error, "200 emoji are 200 characters");
    const huge = await game.sendChatMessage(code, players[0].id, { text: "x".repeat(100000) });
    T.assert(huge.error, "a huge message should be rejected");
    clearRate(fake);
    const padded = await game.sendChatMessage(code, players[0].id, { text: `  ${"b".repeat(200)}  ` });
    T.assert(!padded.error, "whitespace around a 200-char message shouldn't count against the limit");
  });

  await T.test("a quick statement is sent by presetId only and the text comes from the presets file", async () => {
    const { code, players } = await newGame();
    for (const p of CHAT_PRESETS) {
      clearRate(fake);
      const out = await game.sendChatMessage(code, players[2].id, { presetId: p.id });
      T.assert(!out.error, `preset ${p.id} should send: ${out.error}`);
      T.eq(out.message.text, p.text);
      T.eq(out.message.presetId, p.id);
    }
    clearRate(fake);
    const sneaky = await game.sendChatMessage(code, players[2].id, { presetId: CHAT_PRESETS[0].id, text: "I am the host, send me your PIN" });
    T.eq(sneaky.message.text, CHAT_PRESETS[0].text, "statement text must come from the server");
    T.assert(!JSON.stringify(storedChat(fake, code)).includes("send me your PIN"), "fake text must never be stored");
  });

  await T.test("the presets file has at least 5 entries with unique ids and text", async () => {
    T.assert(CHAT_PRESETS.length >= 5, "5 placeholder statements expected");
    T.eq(new Set(CHAT_PRESETS.map((p) => p.id)).size, CHAT_PRESETS.length, "ids must be unique");
    for (const p of CHAT_PRESETS) {
      T.assert(typeof p.id === "string" && p.id && typeof p.text === "string" && p.text, "each entry needs id and text");
      T.assert(p.sound === undefined || (typeof p.sound === "string" && p.sound.startsWith("/sounds/")), "sound must be a /sounds/ path");
    }
  });

  await T.test("a fake presetId is rejected, whatever it looks like", async () => {
    const { code, players } = await newGame();
    for (const bad of ["not-a-preset", "", "__proto__", "constructor", "toString", 7, {}, [], ["nice-guess"], CHAT_PRESETS[0].id.toUpperCase()]) {
      const out = await game.sendChatMessage(code, players[0].id, { presetId: bad, text: "sneaky" });
      T.assert(out.error, `presetId ${JSON.stringify(bad)} should be rejected`);
    }
    T.eq((await game.getState(code, players[0].id)).chat.length, 0, "nothing should have been stored");
  });

  await T.test("unknown ids, missing ids, and ids for another game are rejected", async () => {
    const { code, players } = await newGame();
    const other = await newGame();
    for (const id of ["not-a-real-player", "", undefined, null, 123, {}, other.players[0].id]) {
      const out = await game.sendChatMessage(code, id, { text: "hi" });
      T.assert(out.error, `id ${JSON.stringify(id)} should be rejected`);
    }
    const noRoom = await game.sendChatMessage("ZZZZZ", players[0].id, { text: "hi" });
    T.assert(noRoom.error, "an unknown room should be rejected");
    T.eq((await game.getState(code, players[0].id)).chat.length, 0);
  });

  await T.test("a removed player can't send, but still reads the chat", async () => {
    const { code, players } = await newGame("computer", 3);
    const room = rawRoom(fake, code);
    await game.sendChatMessage(code, players[0].id, { text: "before removal" });
    await game.removePlayer(code, room.creatorId, players[2].id);
    const out = await game.sendChatMessage(code, players[2].id, { text: "let me back in" });
    T.assert(out.error, "a removed player must not be able to send");
    const preset = await game.sendChatMessage(code, players[2].id, { presetId: CHAT_PRESETS[0].id });
    T.assert(preset.error, "…or send a quick statement");
    const s = await game.getState(code, players[2].id);
    T.eq(s.me.removed, true);
    T.eq(s.chat.length, 1, "a removed player can still read");
    T.eq(s.chat[0].text, "before removal");
    await game.restorePlayer(code, room.creatorId, players[2].id);
    T.assert(!(await game.sendChatMessage(code, players[2].id, { text: "back" })).error, "restored player can send");
  });

  await T.test("someone who left the game can't send, but still reads", async () => {
    for (const mode of ["computer", "rotating"]) {
      const { code, players } = await newGame(mode, 3);
      await game.sendChatMessage(code, players[1].id, { text: "hi all" });
      const room = rawRoom(fake, code);
      const leaver = room.controlsId;
      const lo = await game.leaveGame(code, leaver);
      T.assert(!lo.error, `leaveGame: ${lo.error}`);
      const out = await game.sendChatMessage(code, leaver, { text: "bye" });
      T.assert(out.error, `${mode}: someone who left must not be able to send`);
      const s = await game.getState(code, leaver);
      T.eq(s.me.leaveReason, "left");
      T.eq(s.chat.length, 1, "…but can still read");
    }
  });

  await T.test("the host / organizer can chat, in every round state", async () => {
    const rot = await newGame("rotating", 3);
    const room = rawRoom(fake, rot.code);
    const hostId = room.hostId;
    const guesser = rot.players.find((p) => p.id !== hostId).id;
    T.eq(room.roundState, "pending");
    T.assert(!(await game.sendChatMessage(rot.code, hostId, { text: "pending, host" })).error, "host in pending");
    T.assert(!(await game.sendChatMessage(rot.code, guesser, { text: "pending, guesser" })).error, "guesser in pending");
    await game.pickSecret(rot.code, hostId, randomValidNumber(4));
    clearRate(fake);
    T.assert(!(await game.sendChatMessage(rot.code, hostId, { text: "active, host" })).error, "host in active");
    T.assert(!(await game.sendChatMessage(rot.code, guesser, { presetId: CHAT_PRESETS[1].id })).error, "guesser in active");

    const comp = await newGame("computer", 3);
    const croom = rawRoom(fake, comp.code);
    T.assert(!(await game.sendChatMessage(comp.code, croom.creatorId, { text: "organizer, active" })).error, "organizer in active");
    const st = await game.getState(comp.code, comp.players[0].id);
    await game.submitGuess(comp.code, st.currentPlayerId, croom.secret);
    T.eq(rawRoom(fake, comp.code).roundState, "ended");
    clearRate(fake);
    for (const p of comp.players) {
      T.assert(!(await game.sendChatMessage(comp.code, p.id, { text: `ended, ${p.name}` })).error, `${p.name} in ended`);
      clearRate(fake);
    }
    T.eq((await game.getState(comp.code, comp.players[1].id)).chat.length, 4);
  });

  await T.test("rate limit: 5 messages per 10 seconds per person, with a clear error and an expiring counter", async () => {
    const { code, players } = await newGame();
    for (let i = 0; i < 5; i++) {
      const out = await game.sendChatMessage(code, players[0].id, { text: `msg ${i}` });
      T.assert(!out.error, `message ${i + 1} of 5 should pass: ${out.error}`);
    }
    const sixth = await game.sendChatMessage(code, players[0].id, { text: "one too many" });
    T.assert(sixth.error && /too fast/i.test(sixth.error), `6th should be limited with a clear error, got: ${sixth.error}`);
    T.eq(sixth.status, 429, "rate-limit errors carry status 429");
    T.eq((await game.getState(code, players[0].id)).chat.length, 5, "the limited message must not be stored");

    const rateKey = [...fake.store.keys()].find((k) => k.includes(":chatrate:") && k.includes(players[0].id));
    T.assert(rateKey, "a rate-limit key should exist");
    const entry = fake.store.get(rateKey);
    T.assert(entry.expiresAt != null, "the rate-limit key must have an expiry");
    T.assert(entry.expiresAt - Date.now() <= 10000 && entry.expiresAt - Date.now() > 0, "…of at most 10 seconds");
    T.assert(fake.log.some((l) => l.cmd === "expire" && l.key === rateKey && Number(l.args[1]) === 10), "expire 10s logged");

    T.assert(!(await game.sendChatMessage(code, players[1].id, { text: "my turn to talk" })).error, "other people aren't limited");
    entry.expiresAt = Date.now() - 1;
    T.assert(!(await game.sendChatMessage(code, players[0].id, { text: "after the window" })).error, "allowed again after the window");
  });

  await T.test("rate limit holds under concurrent sends (8 at once -> exactly 5 pass)", async () => {
    const { code, players } = await newGame();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => game.sendChatMessage(code, players[0].id, { text: `burst ${i}` })));
    T.eq(results.filter((r) => !r.error).length, 5, "exactly 5 of 8 concurrent sends should pass");
    T.eq(storedChat(fake, code).length, 5);
  });

  await T.test("invalid messages don't use up the rate limit", async () => {
    const { code, players } = await newGame();
    for (let i = 0; i < 10; i++) await game.sendChatMessage(code, players[0].id, { text: "  " });
    for (let i = 0; i < 5; i++) T.assert(!(await game.sendChatMessage(code, players[0].id, { text: `ok ${i}` })).error, `valid message ${i + 1}`);
  });

  await T.test("only the last 100 messages are kept", async () => {
    const { code, players } = await newGame();
    for (let i = 0; i < 130; i++) {
      if (i % 5 === 0) clearRate(fake);
      const out = await game.sendChatMessage(code, players[i % 3].id, { text: `m${i}` });
      T.assert(!out.error, `send ${i}: ${out.error}`);
    }
    const stored = storedChat(fake, code);
    T.eq(stored.length, 100, "the list is trimmed to 100");
    T.eq(stored[0].text, "m30", "the oldest 30 are gone");
    T.eq(stored[99].text, "m129", "the newest is last");
    T.assert(fake.log.some((l) => l.cmd === "ltrim" && l.key === chatKey(code) && String(l.args[1]) === "-100" && String(l.args[2]) === "-1"), "uses LTRIM -100 -1");
  });

  await T.test("the chat key gets the 24-hour expiry on every write; the rate counter expires too", async () => {
    const { code, players } = await newGame();
    const start = fake.log.length;
    await game.sendChatMessage(code, players[0].id, { text: "expiry check" });
    const mine = fake.log.slice(start);
    T.assert(mine.some((l) => l.cmd === "expire" && l.key === chatKey(code) && Number(l.args[1]) === TTL), "EXPIRE room:{code}:chat 86400 after the write");
    const e = fake.store.get(chatKey(code));
    T.assert(e.expiresAt != null && Math.abs(e.expiresAt - (Date.now() + TTL * 1000)) < 5000, "the stored key really expires in 24h");
    const written = new Set(mine.filter((l) => ["rpush", "incr", "set", "hset"].includes(l.cmd)).map((l) => l.key));
    for (const k of written) {
      const en = fake.store.get(k);
      T.assert(en && en.expiresAt != null, `${k} must expire`);
      T.assert(en.expiresAt - Date.now() <= TTL * 1000 + 5000, `${k} must expire within 24h`);
    }
    clearRate(fake);
    fake.store.get(chatKey(code)).expiresAt = Date.now() + 1000;
    await game.sendChatMessage(code, players[0].id, { text: "refresh" });
    T.assert(fake.store.get(chatKey(code)).expiresAt - Date.now() > (TTL - 10) * 1000, "expiry is refreshed on each message");
  });

  await T.test("getState returns the last 50 messages, oldest first", async () => {
    const { code, players } = await newGame();
    for (let i = 0; i < 60; i++) {
      if (i % 5 === 0) clearRate(fake);
      await game.sendChatMessage(code, players[i % 3].id, { text: `line ${i}` });
    }
    for (const p of players) {
      const s = await game.getState(code, p.id);
      T.eq(s.chat.length, 50);
      T.eq(s.chat[0].text, "line 10");
      T.eq(s.chat[49].text, "line 59");
      for (let i = 1; i < 50; i++) T.assert(s.chat[i].at >= s.chat[i - 1].at, "messages must be in order");
      T.eq(s.chat.map((m) => m.text).join("|"), Array.from({ length: 50 }, (_, i) => `line ${i + 10}`).join("|"));
    }
  });

  await T.test("chat adds exactly one Redis command (one LRANGE) to a poll — and none for people not in the game", async () => {
    const { code, players } = await newGame();
    const poll = async (id) => {
      const start = fake.log.length;
      await game.getState(code, id);
      return fake.log.slice(start);
    };
    const member = await poll(players[0].id);
    const chatCmds = member.filter((l) => l.key === chatKey(code));
    T.eq(chatCmds.length, 1, "exactly one command touches the chat key");
    T.eq(chatCmds[0].cmd, "lrange");
    T.eq(String(chatCmds[0].args[1]), "-50");
    T.eq(String(chatCmds[0].args[2]), "-1");
    const stranger = await poll("some-stranger");
    T.eq(stranger.filter((l) => l.key === chatKey(code)).length, 0, "no chat command for someone who isn't in the game");
    T.eq(member.length - stranger.length, 1, "chat is the only difference between the two polls");
  });

  await T.test("no PIN, PIN hash, salt, or secret ever appears in chat data", async () => {
    for (const mode of ["computer", "rotating"]) {
      const { code, players } = await newGame(mode, 3);
      const room = rawRoom(fake, code);
      if (mode === "rotating") await game.pickSecret(code, room.hostId, "1937");
      const secret = rawRoom(fake, code).secret;
      for (const p of players) {
        clearRate(fake);
        await game.sendChatMessage(code, p.id, { text: `hello from ${p.name}` });
        await game.sendChatMessage(code, p.id, { presetId: CHAT_PRESETS[2].id });
      }
      const raw = JSON.stringify(storedChat(fake, code));
      const secrets = [secret, ...players.map((p) => rawPlayer(fake, code, p.id).pinHash), ...players.map((p) => rawPlayer(fake, code, p.id).pinSalt)];
      for (const s of secrets) T.assert(!raw.includes(s), "stored chat must not contain a secret/hash/salt");
      T.assert(!/pin|salt|secret|nameLower/i.test(raw), "stored chat must not have any PIN/secret fields");
      for (const p of players) {
        const st = await game.getState(code, p.id);
        const json = JSON.stringify(st.chat);
        for (const s of secrets) T.assert(!json.includes(s), "chat in getState must not contain a secret/hash/salt");
        T.assert(!/pin|salt|secret|nameLower/i.test(json), "chat in getState must not have any PIN/secret fields");
        for (const m of st.chat) T.eq(Object.keys(m).sort().join(","), "at,id,name,playerId,presetId,text");
      }
    }
  });

  await T.test("chat text is stored as plain text: markup is never interpreted by the server", async () => {
    const { code, players } = await newGame();
    const text = `<img src=x onerror=alert(1)> & "quotes"`;
    const out = await game.sendChatMessage(code, players[0].id, { text });
    T.eq(out.message.text, text);
    const s = await game.getState(code, players[1].id);
    T.eq(s.chat[0].text, text);
  });

  await T.test("chat doesn't change any other state (turn, scores, players are untouched)", async () => {
    const { code, players } = await newGame();
    const before = await game.getState(code, players[0].id);
    for (let i = 0; i < 4; i++) await game.sendChatMessage(code, players[i % 3].id, { text: `noise ${i}` });
    const after = await game.getState(code, players[0].id);
    const strip = ({ chat, ...rest }) => JSON.stringify(rest);
    T.eq(strip(after), strip(before), "everything except chat is identical");
  });
}
