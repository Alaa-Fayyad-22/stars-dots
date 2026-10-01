import fs from "node:fs";
import path from "node:path";
import { createGameWithPlayers, rawPlayer, setRawPlayer, rawRoom } from "./helpers.js";
import { CHAT_PRESETS } from "../lib/chatPresets.js";
import { SPECIAL_PRESETS } from "../lib/specialPresets.js";

const EXPECTED = ["اسرع لو سمحت", "Faster please", "yalla khaye", "هههه", "IQ Level: null", "bqellak bss ma btez3al ?", "ya lateeffff", "AWTTT"];
const clearRate = (fake) => { for (const k of [...fake.store.keys()]) if (k.includes(":chatrate:")) fake.store.delete(k); };

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

export default async function run({ game, fake, T }) {
  T.suite("Special quick statements");

  await T.test("SPECIAL_PRESETS has the requested statements in order, and CHAT_PRESETS is unchanged", () => {
    T.eq(JSON.stringify(SPECIAL_PRESETS.map((p) => p.text)), JSON.stringify(EXPECTED));
    T.eq(JSON.stringify(CHAT_PRESETS.map((p) => p.text)), JSON.stringify(["Nice guess!", "So close!", "Hurry up 😄", "I've got it!", "Good game!"]));
    const ids = [...CHAT_PRESETS, ...SPECIAL_PRESETS].map((p) => p.id);
    T.eq(new Set(ids).size, ids.length, "ids unique across both lists");
  });

  for (const mode of ["rotating", "computer", "duel"]) {
    await T.test(`${mode}: PIN 4444 gives access on create and join; any other PIN does not; the PIN is never stored`, async () => {
      const a = await game.createRoom("Ana", "4444", mode, 4);
      const b = await game.joinRoom(a.code, "Boro", "4444");
      T.assert(rawPlayer(fake, a.code, a.playerId).special === true, "creator with 4444");
      T.assert(rawPlayer(fake, a.code, b.playerId).special === true, "joiner with 4444");
      const c = await game.createRoom("Cleo", "1111", mode, 4);
      const d = await game.joinRoom(c.code, "Dax", "4443");
      T.assert(!rawPlayer(fake, c.code, c.playerId).special, "creator, other PIN");
      T.assert(!rawPlayer(fake, c.code, d.playerId).special, "joiner, other PIN");
      for (const id of [a.playerId, b.playerId]) {
        T.assert(!fake.store.get(`room:${a.code}:players`).value.get(id).includes("4444"), "plain PIN not stored");
      }
    });
  }

  await T.test("rejoin with 4444 gives access only when the PIN is right; access stays; other PINs never give it", async () => {
    const a = await game.createRoom("Ana", "1111", "computer", 4);
    const b = await game.joinRoom(a.code, "Boro", "1111");
    T.assert((await game.rejoinRoom(a.code, "Boro", "4444")).error, "4444 isn't Boro's PIN");
    T.assert(!rawPlayer(fake, a.code, b.playerId).special, "no access from a failed rejoin");
    T.assert(!(await game.rejoinRoom(a.code, "Boro", "1111")).error);
    T.assert(!rawPlayer(fake, a.code, b.playerId).special, "no access from a normal rejoin");
    // Someone whose real PIN is 4444 but whose record predates the flag.
    const c = await game.joinRoom(a.code, "Cleo", "4444");
    setRawPlayer(fake, a.code, c.playerId, { special: undefined });
    T.assert(!rawPlayer(fake, a.code, c.playerId).special, "flag removed for the test");
    T.assert(!(await game.rejoinRoom(a.code, "Cleo", "4444")).error);
    T.assert(rawPlayer(fake, a.code, c.playerId).special === true, "access given on rejoin with 4444");
    T.assert((await game.rejoinRoom(a.code, "Cleo", "1234")).error, "wrong PIN fails");
    T.assert(rawPlayer(fake, a.code, c.playerId).special === true, "access stays");
    T.assert(!(await game.rejoinRoom(a.code, "Cleo", "4444")).error);
    const s = await game.getState(a.code, c.playerId);
    T.eq(s.me.specialPresets.length, 8);
  });

  await T.test("people without access get the old state: no special field, no special text anywhere", async () => {
    for (const mode of ["rotating", "computer", "duel"]) {
      const { code, players } = await createGameWithPlayers(game, { mode, digits: 4, count: mode === "duel" ? 2 : 3 });
      for (const p of players) {
        const s = await game.getState(code, p.id);
        T.assert(!("specialPresets" in s.me), "no specialPresets key");
        const json = JSON.stringify(s);
        for (const t of EXPECTED) T.assert(!json.includes(t), `${mode}: state leaks "${t}"`);
        T.assert(!/special/i.test(json), "no hint of special in state");
      }
      const anon = JSON.stringify(await game.getState(code, { id: "nobody", token: "x" }));
      for (const t of EXPECTED) T.assert(!anon.includes(t));
    }
  });

  await T.test("people with access get the list, in order, in their own state only", async () => {
    const a = await game.createRoom("Ana", "4444", "computer", 4);
    const b = await game.joinRoom(a.code, "Boro", "1111");
    const sa = await game.getState(a.code, a.playerId);
    T.eq(JSON.stringify(sa.me.specialPresets.map((p) => p.text)), JSON.stringify(EXPECTED));
    const sb = JSON.stringify(await game.getState(a.code, b.playerId));
    for (const t of EXPECTED) T.assert(!sb.includes(t), "other player's state has no list");
    T.assert(!JSON.stringify(sa.players).includes("special"), "the players list doesn't reveal who has access");
  });

  await T.test("without access: current statements send as before; special ones are refused with a clear error", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 3 });
    for (const p of CHAT_PRESETS) {
      clearRate(fake);
      const out = await game.sendChatMessage(code, players[1].id, { presetId: p.id });
      T.assert(!out.error, out.error);
      T.eq(out.message.text, p.text);
      T.eq(Object.keys(out.message).sort().join(","), "at,id,name,playerId,presetId,text", "same message shape as before");
    }
    for (const sp of SPECIAL_PRESETS) {
      clearRate(fake);
      const out = await game.sendChatMessage(code, players[1].id, { presetId: sp.id });
      T.assert(out.error && /quick statement/.test(out.error), "refused");
      T.assert(!JSON.stringify(out).includes(sp.text), "error doesn't reveal the text");
    }
    clearRate(fake);
    const unknown = await game.sendChatMessage(code, players[1].id, { presetId: "nope" });
    const special = await game.sendChatMessage(code, players[1].id, { presetId: SPECIAL_PRESETS[0].id });
    T.eq(special.error, unknown.error, "same answer as for an unknown id");
  });

  await T.test("a person without access can't send a special statement, even with made-up text", async () => {
    const { code, players } = await createGameWithPlayers(game, { mode: "computer", digits: 4, count: 2 });
    const out = await game.sendChatMessage(code, players[0].id, { presetId: SPECIAL_PRESETS[0].id, text: "whatever" });
    T.assert(out.error, "refused");
    T.eq((await game.getState(code, players[0].id)).chat.length, 0, "nothing stored");
  });

  await T.test("a special statement from someone with access reaches everyone else, text taken from the server list", async () => {
    const a = await game.createRoom("Ana", "4444", "computer", 4);
    const b = await game.joinRoom(a.code, "Boro", "1111");
    const c = await game.joinRoom(a.code, "Cleo", "2222");
    const sp = SPECIAL_PRESETS[3];
    const out = await game.sendChatMessage(a.code, a.playerId, { presetId: sp.id, text: "ignored" });
    T.assert(!out.error, out.error);
    T.eq(out.message.text, sp.text);
    T.eq(out.message.presetId, sp.id);
    for (const id of [b.playerId, c.playerId]) {
      const m = (await game.getState(a.code, id)).chat.find((x) => x.id === out.message.id);
      T.assert(m && m.text === sp.text && m.presetId === sp.id && m.playerId === a.playerId, "arrives like any statement");
    }
  });

  await T.test("Arabic displays right-to-left: every chat text surface uses dir=\"auto\"", () => {
    const src = fs.readFileSync("app/Chat.js", "utf8");
    for (const needle of ["{p.text}", "{m.text}", "{t.text}", "{alert.text}", "{preview}"]) {
      const esc = needle.replace(/[{}.]/g, "\\$&");
      const re = new RegExp(`<[^<>]*dir="auto"[^<>]*>[^<]*${esc}`);
      T.assert(re.test(src), `dir="auto" on the element showing ${needle}`);
    }
  });

  await T.test("no browser code imports the special list, and the phrases are in no browser bundle", () => {
    const clientFiles = [
      ...walk("app").filter((f) => f.endsWith(".js") && !f.includes(`${path.sep}api${path.sep}`)),
      "lib/client.js", "lib/audio.js", "lib/chatPresets.js", "lib/colors.js", "lib/install.js", "lib/summary.js",
    ];
    for (const f of clientFiles) {
      const s = fs.readFileSync(f, "utf8");
      T.assert(!/specialPresets(\.js)?["']/.test(s) && !/SPECIAL_PRESETS.*from|import[^;]*SPECIAL_PRESETS/.test(s), `${f} must not import the special list`);
    }
    const staticDir = path.join(".next", "static");
    T.assert(fs.existsSync(staticDir), "run `npm run build` before the tests so the bundles can be checked");
    const files = walk(staticDir).filter((f) => /\.(js|css|html|json)$/.test(f));
    T.assert(files.length > 0, "bundle files found");
    for (const f of files) {
      const s = fs.readFileSync(f, "utf8");
      const lower = s.toLowerCase();
      for (const t of EXPECTED) {
        const escaped = t.replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).toLowerCase();
        T.assert(!s.includes(t) && !lower.includes(escaped), `"${t}" found in ${f}`);
      }
    }
  });

  await T.test("no extra Redis commands: polls and guesses cost the same with and without access", async () => {
    const count = async (fn) => { const s = fake.log.length; await fn(); return fake.log.length - s; };
    const counts = [];
    for (const pin of ["1111", "4444"]) {
      const a = await game.createRoom("Ana", pin, "computer", 4);
      const b = await game.joinRoom(a.code, "Boro", pin);
      await game.getState(a.code, a.playerId);
      const poll = await count(() => game.getState(a.code, b.playerId));
      const room = rawRoom(fake, a.code);
      const cur = (await game.getState(a.code, b.playerId)).currentPlayerId;
      const guess = room.secret === "1234" ? "5678" : "1234";
      counts.push([poll, await count(() => game.submitGuess(a.code, cur, guess))]);
    }
    T.eq(counts[1][0], counts[0][0], "poll");
    T.eq(counts[1][1], counts[0][1], "guess");
    T.eq(counts[0][0], 8, "poll baseline");
    T.eq(counts[0][1], 11, "guess baseline");
  });
}
