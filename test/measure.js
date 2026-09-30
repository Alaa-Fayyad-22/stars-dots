// Counts Redis commands for one state poll and one (non-winning) guess.
// Run: node test/measure.js
import { createFakeUpstash } from "./fake-upstash.js";
import { wrapGame } from "./helpers.js";

const fake = createFakeUpstash();
process.env.UPSTASH_REDIS_REST_URL = await fake.listen();
process.env.UPSTASH_REDIS_REST_TOKEN = "t";
delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN;
const rawGame = await import("../lib/game.js");
const game = process.env.BASELINE ? rawGame : wrapGame(rawGame);

async function measure(label, fn) {
  const start = fake.log.length;
  await fn();
  const cmds = fake.log.slice(start).map((c) => c.cmd);
  console.log(`${label}: ${cmds.length} commands  [${cmds.join(",")}]`);
  return cmds.length;
}
for (const mode of ["computer", "rotating"]) {
  const a = await game.createRoom("Ana", "1111", mode, 4);
  const b = await game.joinRoom(a.code, "Boro", "1111");
  const c = await game.joinRoom(a.code, "Cleo", "1111");
  const room = JSON.parse(fake.store.get(`room:${a.code}`).value);
  if (mode === "rotating") await game.pickSecret(a.code, room.hostId, "1234");
  const s = await game.getState(a.code, a.playerId);
  await game.getState(a.code, a.playerId); // warm: steady state
  await measure(`${mode} state poll`, () => game.getState(a.code, b.playerId));
  const cur = s.currentPlayerId;
  await measure(`${mode} guess`, () => game.submitGuess(a.code, cur, "5678"));
}
await fake.close();
