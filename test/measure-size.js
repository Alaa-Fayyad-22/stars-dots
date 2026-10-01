// Redis commands per state poll / guess and the size of a typical poll response,
// for a fixed scenario (4 players, 2 finished rounds, 6 guesses, 2 chat messages).
// Run: node test/measure-size.js   (prints one JSON line per mode)
import { createFakeUpstash } from "./fake-upstash.js";
import { wrapGame } from "./helpers.js";

const fake = createFakeUpstash();
process.env.UPSTASH_REDIS_REST_URL = await fake.listen();
process.env.UPSTASH_REDIS_REST_TOKEN = "t";
delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN;
const game = wrapGame(await import("../lib/game.js"));
const room = (code) => JSON.parse(fake.store.get(`room:${code}`).value);
const count = async (fn) => { const s = fake.log.length; const out = await fn(); return [fake.log.length - s, out]; };

for (const mode of ["rotating", "computer"]) {
  const a = await game.createRoom("Ana", "1111", mode, 4);
  const ids = [a.playerId];
  for (const n of ["Boro", "Cleo", "Dax"]) ids.push((await game.joinRoom(a.code, n, "1111")).playerId);
  const guesses = ["1234", "5678", "9012", "3456", "7890", "2345"];
  let gi = 0;
  async function playRound(win) {
    if (mode === "rotating") await game.pickSecret(a.code, room(a.code).hostId, "4821");
    else if (room(a.code).roundState === "ended") await game.newRound(a.code, ids[0]);
    const secret = mode === "rotating" ? "4821" : room(a.code).secret;
    for (let i = 0; i < 3; i++) {
      const s = await game.getState(a.code, ids[0]);
      await game.submitGuess(a.code, s.currentPlayerId, guesses[gi++ % 6] === secret ? "1357" : guesses[gi % 6]);
    }
    const s = await game.getState(a.code, ids[0]);
    if (win) await game.submitGuess(a.code, s.currentPlayerId, secret);
  }
  await playRound(true);
  await playRound(true);
  await game.sendChatMessage(a.code, ids[0], { text: "hello there" });
  await game.sendChatMessage(a.code, ids[1], { presetId: "nice-guess" });
  if (mode === "rotating") await game.pickSecret(a.code, room(a.code).hostId, "6573");
  else await game.newRound(a.code, ids[0]);
  const s0 = await game.getState(a.code, ids[0]);
  await game.getState(a.code, ids[0]);
  const viewer = ids.find((id) => id !== room(a.code).hostId);
  const [pollCmds, st] = await count(() => game.getState(a.code, viewer));
  const bytes = Buffer.byteLength(JSON.stringify(st));
  const cur = s0.currentPlayerId;
  const [guessCmds] = await count(() => game.submitGuess(a.code, cur, "1357"));
  console.log(JSON.stringify({ mode, pollCmds, guessCmds, pollBytes: bytes }));
}
// A duel (new in this update, so no "before"): same kind of numbers.
{
  const a = await game.createRoom("Ana", "1111", "duel", 4);
  const b = await game.joinRoom(a.code, "Boro", "1111");
  await game.pickSecret(a.code, a.playerId, "1234");
  await game.pickSecret(a.code, b.playerId, "5678");
  await game.submitGuess(a.code, a.playerId, "1357");
  await game.submitGuess(a.code, b.playerId, "2468");
  await game.sendChatMessage(a.code, a.playerId, { text: "hello there" });
  await game.getState(a.code, b.playerId);
  const [pollCmds, st] = await count(() => game.getState(a.code, b.playerId));
  const [guessCmds] = await count(() => game.submitGuess(a.code, a.playerId, "2357"));
  console.log(JSON.stringify({ mode: "duel", pollCmds, guessCmds, pollBytes: Buffer.byteLength(JSON.stringify(st)) }));
}
await fake.close();
