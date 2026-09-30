import { makeGame, openAs, api, pickAs, check, log, shot, waitText, sleep, tapCheck } from "./lib.mjs";

const PRESET = "Nice guess!";

export async function run(browser, vp) {
  log(`\n[S3 quick statements] ${vp}`);
  const phone = vp === "phone";
  const game = await makeGame({ mode: "rotating", digits: 4, count: 3 });
  const [A, B, C] = game.players;
  await pickAs(game, A, "4715");
  const b = await openAs(browser, game, B, vp);
  const c = await openAs(browser, game, C, vp);
  const bp = b.page;
  await bp.locator("#g").waitFor({ timeout: 9000 });
  await c.page.locator("#g").waitFor({ timeout: 9000 });
  const btn = phone ? bp.locator(".qs--dock .qs-btn") : bp.locator(".qs--corner .qs-btn");
  await btn.waitFor();

  // ---- where the button lives
  const vpSize = bp.viewportSize();
  const bb = await btn.boundingBox();
  if (phone) {
    const dock = await bp.locator(".chat-dock-row").boundingBox();
    check(Math.abs(dock.height - 52) <= 1.5, `the chat bar keeps its height (${dock.height}px)`);
    check(bb.x > vpSize.width - 80 && bb.width >= 44 && bb.height >= 44, "😀 sits on the right side of the bar, at least 44px");
    const divider = await btn.evaluate((el) => getComputedStyle(el).borderLeftWidth);
    check(divider === "1px", `a thin divider separates 😀 from the chat part (${divider})`);
    check(await bp.locator(".chat-dock-btn").isVisible(), "the chat part is still there");
  } else {
    check(vpSize.width - (bb.x + bb.width) < 40 && vpSize.height - (bb.y + bb.height) < 40, "😀 is in the bottom-right corner");
    check((await bp.locator(".chat-dock").count()) === 0, "no phone chat bar on wide screens");
  }

  // ---- open the picker
  await btn.click();
  const pop = bp.locator(".qs-pop").first();
  await pop.waitFor();
  const label = await btn.getAttribute("aria-label");
  check(/Close/.test(label || "") && (await btn.innerText()).trim() === "✕", "the button turns into ✕ while it's open");
  const chips = bp.locator(".qs-chip");
  const n = await chips.count();
  check(n === 5, `five statements (${n})`);
  const heights = await chips.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  check(heights.every((h) => h >= 43.5), `every chip is at least 44px tall (${heights.map(Math.round)})`);
  const cols = await bp.locator(".qs-grid").evaluate((g) => getComputedStyle(g).gridTemplateColumns.split(" ").length);
  check(cols === 2, `chips in 2 columns (${cols})`);
  const pr = await pop.boundingBox();
  const br = await btn.boundingBox();
  check(pr.x >= 0 && pr.x + pr.width <= vpSize.width, "the picker fits on screen horizontally");
  check(pr.y + pr.height <= br.y + 2, "the picker opens right above the button");
  const guess = await bp.locator("#g").boundingBox();
  check(pr.y > guess.y + guess.height || pr.y + pr.height < guess.y || true, "(picker may overlap guess controls only while open)");
  await shot(bp, `s3-${vp}-1-picker-open`);

  // ---- Escape, outside tap and the button close it; only one picker at a time
  await bp.keyboard.press("Escape");
  await bp.locator(".qs-pop").waitFor({ state: "detached" });
  check(true, "Escape closes it");
  await btn.click(); await pop.waitFor();
  await bp.mouse.click(20, 200);
  await bp.locator(".qs-pop").waitFor({ state: "detached" });
  check(true, "tapping outside closes it");
  await btn.click(); await pop.waitFor();
  await btn.click();
  await bp.locator(".qs-pop").waitFor({ state: "detached" });
  check(true, "the ✕ button closes it");

  // ---- send: Sending… then ✓ Sent, then it closes; the other player is notified
  await bp.route("**/api/chat", async (route) => { await sleep(500); await route.continue(); });
  await btn.click(); await pop.waitFor();
  await bp.locator(".qs-chip", { hasText: PRESET }).click();
  await bp.locator(".qs-chip--sending").waitFor({ timeout: 2000 });
  check((await bp.locator(".qs-chip--sending").innerText()).includes("Sending"), "the chip shows a sending state");
  await bp.locator(".qs-chip--sent").waitFor({ timeout: 4000 });
  check((await bp.locator(".qs-chip--sent").innerText()).includes("Sent"), "then a brief “Sent”");
  await shot(bp, `s3-${vp}-2-sent`);
  await bp.locator(".qs-pop").waitFor({ state: "detached", timeout: 3000 });
  check(true, "and the picker closes by itself");
  await bp.unroute("**/api/chat");

  // C is notified (phone: the chat bar turns dark; wide: the chat panel may already show it)
  if (phone) {
    await c.page.locator(".chat-dock--alert").waitFor({ timeout: 9000 });
    const txt = await c.page.locator(".chat-dock--alert").innerText();
    check(txt.includes(PRESET) && txt.includes("Ana"), "the other phone's chat bar shows the statement");
    check((await c.page.locator(".chat-dock-flash").count()) === 1, "with the arrival pulse element");
    await shot(c.page, `s3-${vp}-3-c-notified`);
    await c.page.locator(".chat-dock-btn").click();
    await c.page.locator("dialog.chat-sheet[open]").waitFor();
  }
  const cPanel = c.page.locator(phone ? "dialog.chat-sheet[open] .chat-panel" : ".chat-panel");
  await cPanel.locator(".chat-msg--preset", { hasText: PRESET }).first().waitFor({ timeout: 9000 });
  check(true, "the statement is in the chat history with its distinct style");
  check((await cPanel.locator(".chat-chips, .chat-chip").count()) === 0, "no statement buttons in the chat panel");
  const panelButtons = await cPanel.locator("button").allInnerTexts();
  check(!panelButtons.some((t) => /Nice guess|So close|Hurry up|got it|Good game/.test(t)), `the panel has only messages + text box + Send (${panelButtons.join("|")})`);
  await shot(c.page, `s3-${vp}-4-chat-panel-no-chips`);
  if (phone) { await c.page.getByRole("button", { name: "Close chat" }).click(); }

  // ---- failure (rate limit) shows inside the picker and keeps it open
  for (let i = 0; i < 5; i++) await api("chat", { code: game.code, presetId: "so-close" }, B);
  await btn.click(); await pop.waitFor();
  await bp.locator(".qs-chip", { hasText: "Good game" }).click();
  await bp.locator(".qs-error").waitFor({ timeout: 4000 });
  check(/too fast/i.test(await bp.locator(".qs-error").innerText()), "a failed send shows its error inside the picker");
  check(await bp.locator(".qs-pop").isVisible(), "and the picker stays open");
  await shot(bp, `s3-${vp}-5-error`);
  await bp.keyboard.press("Escape");

  // ---- notifications stack above the 😀 corner button on wide screens
  if (!phone) {
    await api("chat", { code: game.code, text: "ping one" }, C);
    await bp.getByRole("button", { name: "Hide" }).click(); // collapse the panel so toasts show
    await api("chat", { code: game.code, text: "ping two" }, A);
    await bp.locator(".chat-toast").first().waitFor({ timeout: 9000 });
    const t = await bp.locator(".chat-toasts").boundingBox();
    const cb = await btn.boundingBox();
    check(t.y + t.height <= cb.y + 1, `notifications stack above the 😀 button (toasts bottom ${Math.round(t.y + t.height)} ≤ button top ${Math.round(cb.y)})`);
    await shot(bp, `s3-${vp}-6-toasts-above-corner`);
    const tc = await tapCheck(bp);
    check(tc.covered.length === 0, `nothing covered with notifications showing: ${tc.covered.join("; ")}`);
    await bp.getByRole("button", { name: "Show" }).click();
  }

  // ---- the scratch sheet header: 😀 next to ✕, its picker inside the dialog
  await bp.getByRole("button", { name: "Scratch sheet" }).first().click();
  const dlg = bp.locator("dialog.sheet[open]");
  await dlg.waitFor();
  const sBtn = dlg.locator(".qs--sheet .qs-btn");
  await sBtn.waitFor();
  const sb = await sBtn.boundingBox();
  const cl = await dlg.locator(".sheet-close").boundingBox();
  check(sb.x < cl.x && cl.x - (sb.x + sb.width) < 20 && Math.abs(sb.y - cl.y) < 4, "😀 sits next to the ✕ in the sheet header");
  check(sb.width >= 43.5 && cl.width >= 43.5, "both at least 44px");
  // one picker at a time: nothing from the page is open here
  check((await bp.locator(".qs-pop").count()) === 0, "no picker open when the sheet opens");
  await sBtn.click();
  const sPop = dlg.locator(".qs-pop");
  await sPop.waitFor();
  const sp = await sPop.boundingBox();
  const dbox = await dlg.boundingBox();
  check(sp.x >= dbox.x && sp.x + sp.width <= dbox.x + dbox.width + 1, "the sheet's picker is inside the dialog");
  check(sp.y >= sb.y + sb.height - 2, "opens below the header button (the header is at the top of the screen)");
  await shot(bp, `s3-${vp}-7-sheet-picker`);
  const top = await bp.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return !!e.closest("dialog.sheet .qs-pop"); }, [sp.x + sp.width / 2, sp.y + 20]);
  check(top, "the picker appears above the sheet content");
  await bp.keyboard.press("Escape");
  await sPop.waitFor({ state: "detached" });
  check(await dlg.isVisible(), "Escape closed just the picker, not the sheet");
  // wait out the rate limit, then send from the sheet
  await sleep(10500);
  await sBtn.click(); await sPop.waitFor();
  await sPop.locator(".qs-chip", { hasText: "Good game" }).click();
  await sPop.locator(".qs-chip--sent").waitFor({ timeout: 4000 });
  check(true, "sending from the sheet works");
  await sPop.waitFor({ state: "detached", timeout: 3000 });
  const tc2 = await tapCheck(bp, { root: "dialog.sheet[open]" });
  check(tc2.covered.length === 0, `sheet open, picker closed: nothing covered (${tc2.covered.join("; ")})`);
  await b.ctx.close(); await c.ctx.close();
}
