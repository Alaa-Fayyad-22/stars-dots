import { createFakeUpstash } from "./fake-upstash.js";
import { makeT } from "./helpers.js";

const fake = createFakeUpstash();
const url = await fake.listen();
process.env.UPSTASH_REDIS_REST_URL = url;
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
// Make sure a real KV_* pair (from .env, if present) never wins the lookup
// in lib/game.js and points tests at a real database by accident.
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;

const game = await import("../lib/game.js");
const T = makeT();

const suites = [
  "./matrix.test.js",
  "./rotating.test.js",
  "./computer.test.js",
  "./validation.test.js",
  "./rejoin.test.js",
  "./edge.test.js",
  "./expiry.test.js",
  "./compat.test.js",
];

for (const path of suites) {
  const mod = await import(path);
  await mod.default({ game, fake, T });
}

const ok = T.summary();
await fake.close();
process.exit(ok ? 0 : 1);
