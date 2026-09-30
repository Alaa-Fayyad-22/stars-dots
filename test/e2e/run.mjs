import { launch, counts, failures, log } from "./lib.mjs";

const which = process.argv[2] || "all";
const vps = (process.argv[3] || "phone,tablet,laptop").split(",");
const browser = await launch();
const suites = which === "all"
  ? ["s1-rotation", "s2-leave", "s3-picker", "s4-part5", "s5-oldstorage", "s6-tapcheck", "s7-computer"]
  : which.split(",");
for (const name of suites) {
  const mod = await import(`./${name}.mjs`);
  for (const vp of vps) {
    try { await mod.run(browser, vp); }
    catch (e) { failures.push(`${name}/${vp} crashed: ${e.message}`); console.log(`  CRASH ${name}/${vp}:`, e.stack.split("\n").slice(0, 4).join("\n"));
    }
  }
}
await browser.close();
const c = counts();
log(`\nE2E: ${c.passed} passed, ${c.failed} failed`);
if (c.failed) { log(failures.map((f) => "- " + f).join("\n")); process.exit(1); }
