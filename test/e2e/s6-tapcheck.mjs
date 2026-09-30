import { makeGame, openAs, api, getState, pickAs, wrongGuess, check, log, shot, sleep, tapCheck, noHorizontalScroll } from "./lib.mjs";

const positions = async (page) => {
  const h = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  return [["top", 0], ["middle", Math.round(h / 2)], ["bottom", h]];
};

// Every visible button / input / link, at the top, middle and bottom of the page:
// is it what you'd actually tap? Reports what's covered and by what.
async function sweep(page, label, { allowNotif = true, allowPicker = false, small = new Set() } = {}) {
  for (const [name, y] of await positions(page)) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await sleep(500);
    const r = await tapCheck(page);
    for (const s of r.small) small.add(s);
    check(r.covered.length === 0, `${label} @${name}: nothing covered [${r.checked} checked] ${r.covered.join("; ")}`);
    if (!allowNotif) check(r.notifCovered.length === 0, `${label} @${name}: no notification covers anything ${r.notifCovered.join("; ")}`);
    else if (r.notifCovered.length) log(`    (info) ${label} @${name}: covered only by notifications/picker: ${r.notifCovered.join("; ")}`);
    check(await noHorizontalScroll(page), `${label} @${name}: no sideways scroll`);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

export async function run(browser, vp) {
  log(`\n[S6 tap check] ${vp}`);
  const phone = vp === "phone";
  const small = new Set();
  for (const dark of [false, true]) {
    const tag = `${vp}${dark ? "-dark" : ""}`;
    const game = await makeGame({ mode: "rotating", digits: 4, count: 4 });
    const [A, B, C, D] = game.players;
    await pickAs(game, A, "4715");
    const b = await openAs(browser, game, B, vp, { dark });
    const c = await openAs(browser, game, C, vp, { dark });
    const a = await openAs(browser, game, A, vp, { dark });
    await b.page.locator("#g").waitFor({ timeout: 9000 });
    await c.page.locator("#g").waitFor({ timeout: 9000 });
    await a.page.getByText("You're hosting this round").waitFor({ timeout: 9000 });

    // 1. plain main view (my turn), picker closed
    await sweep(b.page, `${tag} main view`, { small });
    await shot(b.page, `s6-${tag}-main`);

    // 2. with notifications showing (chat message + the turn notice)
    await api("chat", { code: game.code, presetId: "hurry-up" }, C);
    await api("chat", { code: game.code, text: "another one" }, D);
    await b.page.locator(phone ? ".chat-dock--alert" : ".chat-toast").first().waitFor({ timeout: 9000 }).catch(() => {});
    if (!phone) await b.page.getByRole("button", { name: "Hide" }).click().catch(() => {});
    await sweep(b.page, `${tag} notifications showing`, { small });
    await shot(b.page, `s6-${tag}-notifs`);

    // 3. picker open: only the picker covers
    const qs = phone ? b.page.locator(".qs--dock .qs-btn") : b.page.locator(".qs--corner .qs-btn");
    await qs.click();
    const r = await tapCheck(b.page);
    check(r.covered.length === 0, `${tag} picker open: only the picker itself covers anything (${r.covered.join("; ")})`);
    await b.page.keyboard.press("Escape");
    const r2 = await tapCheck(b.page);
    check(r2.covered.length === 0 && !r2.notifCovered.some((x) => /qs-pop/.test(x)), `${tag} picker closed: no leftovers`);

    // 4. scratch sheet open
    await b.page.evaluate(() => window.scrollTo(0, 0));
    await b.page.getByRole("button", { name: "Scratch sheet" }).first().click();
    await b.page.locator("dialog.sheet[open]").waitFor();
    const rs = await tapCheck(b.page, { root: "dialog.sheet[open]" });
    for (const s of rs.small) small.add(`(sheet) ${s}`);
    check(rs.covered.length === 0, `${tag} scratch sheet open: nothing covered [${rs.checked} checked] ${rs.covered.join("; ")}`);
    await shot(b.page, `s6-${tag}-sheet`);
    await b.page.locator("dialog.sheet[open] .qs--sheet .qs-btn").click();
    const rp = await tapCheck(b.page, { root: "dialog.sheet[open]" });
    check(rp.covered.length === 0, `${tag} sheet picker open: only the picker covers (${rp.covered.join("; ")})`);
    await b.page.keyboard.press("Escape");
    await b.page.locator("dialog.sheet[open] .sheet-close").click();
    await sleep(300);

    // 5. phone: bar collapsed and expanded
    if (phone) {
      await b.page.evaluate(() => window.scrollTo(0, 0));
      await b.page.mouse.wheel(0, 700); await sleep(150); await b.page.mouse.wheel(0, 400);
      await b.page.waitForFunction(() => document.querySelector(".chat-dock--slim"), null, { timeout: 4000 }).catch(() => {});
      const rc = await tapCheck(b.page);
      check(rc.covered.length === 0, `${tag} bar collapsed: nothing covered (${rc.covered.join("; ")})`);
      await shot(b.page, `s6-${tag}-slim`);
      await b.page.mouse.wheel(0, -200);
      await b.page.waitForFunction(() => !document.querySelector(".chat-dock--slim"), null, { timeout: 4000 });
      const re = await tapCheck(b.page);
      check(re.covered.length === 0, `${tag} bar expanded: nothing covered (${re.covered.join("; ")})`);
    }

    // 6. the host's view, with Host controls open and the remove confirmation
    await a.page.getByRole("button", { name: /Host controls/ }).scrollIntoViewIfNeeded();
    if ((await a.page.getByRole("button", { name: /Host controls/ }).getAttribute("aria-expanded")) !== "true") await a.page.getByRole("button", { name: /Host controls/ }).click();
    await a.page.locator(".players > li.who", { hasText: "Cleo" }).getByRole("button", { name: "Remove" }).click();
    await sweep(a.page, `${tag} host view (controls open, remove confirm)`, { small });
    await shot(a.page, `s6-${tag}-host`);

    // 7. an away player's screen
    await api("leave", { code: game.code }, D);
    const d = await openAs(browser, game, D, vp, { dark });
    await d.page.getByRole("button", { name: "Rejoin", exact: true }).waitFor({ timeout: 9000 });
    await sweep(d.page, `${tag} away screen`, { small });
    await shot(d.page, `s6-${tag}-away`);
    await d.ctx.close();

    // 8. chat open (phone: sheet; wide: panel) with the "Your turn!" notice showing
    await a.ctx.close(); await b.ctx.close(); await c.ctx.close();
  }
  if (small.size) log(`  (info) targets under 44px in ${vp}: ${[...small].join(" | ")}`);
}
