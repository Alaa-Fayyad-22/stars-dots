import { createFakeUpstash } from "./fake-upstash.js";

const port = Number(process.argv[2] || 8791);
const fake = createFakeUpstash();
const url = await fake.listen(port);
console.log(`FAKE_UPSTASH_URL=${url}`);

process.on("SIGINT", async () => { await fake.close(); process.exit(0); });
process.on("SIGTERM", async () => { await fake.close(); process.exit(0); });
