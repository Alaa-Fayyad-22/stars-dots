import { makeGame, openAs, check, log, shot, waitText, BASE, VIEWPORTS } from "./lib.mjs";

// Data saved by the old version (just a player id) must lead to the rejoin screen, not a crash.
export async function run(browser, vp) {
  log(`\n[S5 old localStorage] ${vp}`);
  const game = await makeGame({ mode: "computer", digits: 3, count: 2 });
  const [A, B] = game.players;
  for (const [label, value] of [
    ["an old id-only string", A.id],
    ["an id with a bad token", JSON.stringify({ id: A.id, token: "not-a-real-token" })],
    ["garbage", "{oops"],
    ["someone else's token with my id", JSON.stringify({ id: A.id, token: B.token })],
  ]) {
    const ctx = await browser.newContext({ ...VIEWPORTS[vp] });
    await ctx.addInitScript(([code, v]) => { try { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem(`sd:${code}`, v); } } catch {} }, [game.code, value]);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${BASE}/game/${game.code}`);
    await page.getByRole("tab", { name: "Already in this game?" }).waitFor({ timeout: 9000 });
    check(true, `${label}: the entry screen (New player / Already in this game?) appears`);
    check(errors.length === 0, `${label}: no page errors (${errors.join("; ")})`);
    if (label === "an old id-only string") {
      await shot(page, `s5-${vp}-old-storage`);
      await page.getByRole("tab", { name: "Already in this game?" }).click();
      await page.locator("#rn").selectOption({ label: A.name });
      await page.fill("#rp", A.pin);
      await page.getByRole("button", { name: "Rejoin" }).last().click();
      await page.locator("#g").waitFor({ timeout: 9000 });
      const saved = JSON.parse(await page.evaluate((code) => localStorage.getItem(`sd:${code}`), game.code));
      check(saved.id === A.id && /^[0-9a-f]{64}$/.test(saved.token), "rejoining with name + PIN saved a fresh id + token");
      await page.reload();
      await page.locator("#g").waitFor({ timeout: 9000 });
      check(true, "and the game opens straight away afterwards");
    }
    await ctx.close();
  }
}
