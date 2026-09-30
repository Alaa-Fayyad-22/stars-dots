import { makeGame, openAs, api, getState, pickAs, wrongGuess, check, log, shot, waitText, sleep, tapCheck, noHorizontalScroll } from "./lib.mjs";

// The page polls every 3s, so let it SEE that the turn moved away before bringing it back.
async function passAwayThenBack(game, who, C) {
  const { getState, wrongGuess, sleep } = await import("./lib.mjs");
  let g = 0;
  while ((await getState(game.code, C)).currentPlayerId === who.id && g++ < 3) await wrongGuess(game, C);
  await sleep(3600);
  g = 0;
  while ((await getState(game.code, C)).currentPlayerId !== who.id && g++ < 6) await wrongGuess(game, C);
}
const guarded = async (name, fn) => {
  try { await fn(); } catch (e) { check(false, `${name} crashed: ${String(e.message).split("\n")[0]}`); console.log(e.stack.split("\n").slice(0, 3).join("\n")); }
};

async function openChatView(page, phone) {
  if (phone) {
    await page.getByRole("button", { name: /Open chat/ }).click();
    await page.locator("dialog.chat-sheet[open]").waitFor();
    return page.locator("dialog.chat-sheet[open] .chat-panel");
  }
  const show = page.getByRole("button", { name: "Show" });
  if (await show.count()) await show.click();
  await page.locator(".chat-panel").waitFor();
  return page.locator(".chat-panel");
}

export async function run(browser, vp) {
  log(`\n[S4 part 5] ${vp}`);
  const phone = vp === "phone";
  const game = await makeGame({ mode: "rotating", digits: 4, count: 4 });
  const [A, B, C, D] = game.players;
  await pickAs(game, A, "4715");
  const a = await openAs(browser, game, A, vp);
  const b = await openAs(browser, game, B, vp, { fakeAudio: true });
  const c = await openAs(browser, game, C, vp, { fakeAudio: true });
  await b.page.locator("#g").waitFor({ timeout: 9000 });
  await c.page.locator("#g").waitFor({ timeout: 9000 });

  // ---------- 6. Copy code + Invite
  await guarded("copy code", async () => {
    const btn = b.page.getByRole("button", { name: /Copy game code|Game code copied/ });
    const box = await btn.boundingBox();
    check(box.height >= 43.5, `Copy code is at least 44px tall (${Math.round(box.height)})`);
    check(/Copy code/.test(await btn.innerText()), "the button says Copy code");
    await btn.click();
    check(/Copied/.test(await btn.innerText()), "it says Copied after tapping");
    check((await b.page.evaluate(() => navigator.clipboard.readText())) === game.code, "the code is on the clipboard");
    await sleep(2100);
    check(/Copy code/.test(await btn.innerText()), "and goes back to Copy code");
    await b.page.getByRole("button", { name: /^Invite/ }).click();
    check(/Link copied/.test(await b.page.getByRole("button", { name: /Link copied/ }).innerText()), "Invite still shares (copies) the link");
    check((await b.page.evaluate(() => navigator.clipboard.readText())).endsWith(`/game/${game.code}`), "the link is on the clipboard");
    await shot(b.page, `s4-${vp}-copy-code`);
  });

  // ---------- 5. Host controls (collapsible)
  await guarded("host controls", async () => {
    const head = a.page.getByRole("button", { name: /Host controls/ });
    await head.scrollIntoViewIfNeeded();
    check((await head.getAttribute("aria-expanded")) === "false", "Host controls starts closed");
    check(/Ana's turn/.test(await head.innerText()), `the closed header shows whose turn it is (${(await head.innerText()).replace(/\n/g, " ")})`);
    check((await a.page.getByRole("button", { name: "End round" }).count()) === 0, "controls are hidden while closed");
    await wrongGuess(game, A); // Ana guesses → Boro's turn
    await a.page.getByRole("button", { name: /Host controls.*Boro's turn/ }).waitFor({ timeout: 9000 });
    check(true, "the header follows the turn without opening it");
    await head.click();
    check(await a.page.getByRole("button", { name: /Skip Boro's turn/ }).isVisible(), "open: Skip turn");
    check(await a.page.getByRole("button", { name: "End round" }).isVisible(), "open: End round");
    check(await a.page.getByRole("button", { name: "Leave game" }).isVisible(), "open: Leave game");
    await shot(a.page, `s4-${vp}-host-controls-open`);
    await a.page.reload();
    await a.page.getByRole("button", { name: /Host controls/ }).waitFor();
    check((await a.page.getByRole("button", { name: /Host controls/ }).getAttribute("aria-expanded")) === "true", "open state is remembered after a reload");
    await a.page.getByRole("button", { name: /Host controls/ }).click();
    await a.page.reload();
    await a.page.getByRole("button", { name: /Host controls/ }).waitFor();
    check((await a.page.getByRole("button", { name: /Host controls/ }).getAttribute("aria-expanded")) === "false", "and so is closed");
    // computer mode says Organizer controls
    const cg = await makeGame({ mode: "computer", digits: 3, count: 2 });
    const org = await openAs(browser, cg, cg.players[0], vp);
    await org.page.getByRole("button", { name: /Organizer controls/ }).waitFor({ timeout: 9000 });
    check(true, "computer mode: “Organizer controls”");
    await org.ctx.close();
  });

  // ---------- 7. Remove confirmation
  await guarded("remove confirm", async () => {
    const row = a.page.locator(".players > li.who", { hasText: "Cleo" }).first();
    await row.scrollIntoViewIfNeeded();
    await row.getByRole("button", { name: "Remove" }).click();
    check(await a.page.getByText("Remove Cleo?").isVisible(), "tapping Remove asks “Remove Cleo?”");
    const yes = row.getByRole("button", { name: "Yes" });
    const cancel = row.getByRole("button", { name: "Cancel" });
    const yb = await yes.boundingBox(); const cb = await cancel.boundingBox();
    check(yb.height >= 43.5 && cb.height >= 43.5, "Yes / Cancel are at least 44px tall");
    await shot(a.page, `s4-${vp}-remove-confirm`);
    await cancel.click();
    check((await getState(game.code, A)).players.find((p) => p.id === D.id && !p.removed) !== undefined, "Cancel removes nobody");
    await row.getByRole("button", { name: "Remove" }).click();
    await row.getByRole("button", { name: "Yes" }).click();
    await a.page.getByRole("heading", { name: "Removed players" }).waitFor({ timeout: 9000 });
    check((await getState(game.code, A)).players.find((p) => p.id === D.id).removed, "Yes removes them");
    await a.page.getByRole("button", { name: "Restore" }).click(); // one tap
    await a.page.getByRole("heading", { name: "Removed players" }).waitFor({ state: "detached", timeout: 9000 });
    check(!(await getState(game.code, A)).players.find((p) => p.id === D.id).removed, "Restore stays one tap");
  });

  // ---------- 9. Long-press / right-click copies a message
  await guarded("copy message", async () => {
    await api("chat", { code: game.code, text: "copy me 123" }, C);
    const panel = await openChatView(b.page, phone);
    const msg = panel.locator(".chat-msg", { hasText: "copy me 123" }).first();
    await msg.waitFor({ timeout: 9000 });
    const us = await msg.locator(".chat-text").evaluate((el) => [getComputedStyle(el).userSelect, getComputedStyle(el).webkitTouchCallout]);
    check(us[0] !== "none" && us[1] !== "none", `text selection isn't disabled (${us})`);
    const bb = await msg.boundingBox();
    if (phone || vp === "tablet") {
      const cdp = await b.ctx.newCDPSession(b.page);
      const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
      const x = bb.x + bb.width / 2, y = bb.y + bb.height / 2;
      await touch("touchStart", x, y); await sleep(750); await touch("touchEnd", x, y);
      await msg.locator(".chat-copied").waitFor({ timeout: 2000 });
      check((await b.page.evaluate(() => navigator.clipboard.readText())) === "copy me 123", "long-press copies the message text");
      await shot(b.page, `s4-${vp}-copied`);
      await sleep(1500);
      await b.page.evaluate(() => navigator.clipboard.writeText("untouched"));
      await touch("touchStart", x, y); await touch("touchMove", x, y + 40); await sleep(750); await touch("touchEnd", x, y + 40);
      check((await msg.locator(".chat-copied").count()) === 0 && (await b.page.evaluate(() => navigator.clipboard.readText())) === "untouched", "a press that moves (a scroll) doesn't copy");
    }
    if (!phone) {
      await b.page.evaluate(() => navigator.clipboard.writeText("untouched"));
      await msg.click({ button: "right" });
      await msg.locator(".chat-copied").waitFor({ timeout: 2000 });
      check((await b.page.evaluate(() => navigator.clipboard.readText())) === "copy me 123", "right-click copies the message text");
    }
    if (phone) await b.page.getByRole("button", { name: "Close chat" }).click();
  });

  // ---------- 2. "New messages ↓" pill
  await guarded("new messages pill", async () => {
    for (const who of [C, D, A]) for (let i = 0; i < 5; i++) await api("chat", { code: game.code, text: `filler ${who.name} ${i}` }, who);
    const panel = await openChatView(b.page, phone);
    await panel.locator(".chat-msg", { hasText: `filler Hosty 4` }).waitFor({ timeout: 9000 });
    const list = panel.locator(".chat-list");
    const atBottom = () => list.evaluate((l) => l.scrollHeight - l.scrollTop - l.clientHeight < 40);
    check(await atBottom(), "at the bottom, the list follows the newest message");
    check((await panel.locator(".chat-newpill").count()) === 0, "no pill while at the bottom");
    await list.evaluate((l) => { l.scrollTop = 0; });
    await sleep(300);
    await sleep(10500); // let the rate-limit windows reset
    await api("chat", { code: game.code, text: "fresh one" }, A);
    await panel.locator(".chat-newpill").waitFor({ timeout: 9000 });
    check((await panel.locator(".chat-newpill").innerText()).includes("New messages"), "a “New messages ↓” pill appears");
    const top = await list.evaluate((l) => l.scrollTop);
    check(top < 40, `no auto-scroll while reading older messages (scrollTop ${top})`);
    const pb = await panel.locator(".chat-newpill").boundingBox();
    check(pb.height >= 43.5, "the pill is at least 44px tall");
    await shot(b.page, `s4-${vp}-pill`);
    await panel.locator(".chat-newpill").click();
    await sleep(700);
    check(await atBottom(), "tapping it jumps to the newest message");
    check((await panel.locator(".chat-newpill").count()) === 0, "and the pill disappears");
    await list.evaluate((l) => { l.scrollTop = 0; });
    await api("chat", { code: game.code, text: "fresh two" }, C);
    await panel.locator(".chat-newpill").waitFor({ timeout: 9000 });
    await list.evaluate((l) => { l.scrollTop = l.scrollHeight; });
    await panel.locator(".chat-newpill").waitFor({ state: "detached", timeout: 3000 });
    check(true, "scrolling to the bottom by hand also removes the pill");
    if (phone) await b.page.getByRole("button", { name: "Close chat" }).click();
  });

  // ---------- 3. Swipe to dismiss (tablet / laptop toasts)
  if (!phone) await guarded("swipe toast", async () => {
    await b.page.getByRole("button", { name: "Hide" }).click();
    await sleep(10500);
    await api("chat", { code: game.code, text: "swipe me away" }, C);
    const toast = b.page.locator(".chat-toast", { hasText: "swipe me away" });
    await toast.waitFor({ timeout: 9000 });
    let bb = await toast.boundingBox();
    const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
    await b.page.mouse.move(cx, cy); await b.page.mouse.down(); await b.page.mouse.move(cx + 25, cy, { steps: 4 }); await b.page.mouse.up();
    await sleep(300);
    check(await toast.isVisible(), "a short drag snaps back");
    bb = await toast.boundingBox();
    await b.page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await b.page.mouse.down();
    await b.page.mouse.move(bb.x + bb.width / 2 + 60, bb.y + bb.height / 2, { steps: 4 });
    await b.page.mouse.move(bb.x + bb.width / 2 + 160, bb.y + bb.height / 2, { steps: 6 });
    await b.page.mouse.up();
    await toast.waitFor({ state: "detached", timeout: 3000 });
    check(true, "dragging it sideways dismisses it");
    check((await b.page.locator(".chat-panel").count()) === 0, "without opening the chat");
    await api("chat", { code: game.code, text: "use the x" }, D);
    const t2 = b.page.locator(".chat-toast", { hasText: "use the x" });
    await t2.waitFor({ timeout: 9000 });
    await t2.getByRole("button", { name: /Dismiss/ }).click();
    await t2.waitFor({ state: "detached", timeout: 2000 });
    check(true, "the ✕ still works");
    await b.page.getByRole("button", { name: "Show" }).click();
  });

  // ---------- 4. Phone chat bar collapses on scroll
  if (phone) await guarded("dock collapse", async () => {
    const dock = b.page.locator(".chat-dock");
    const clearance = () => b.page.locator(".chat-clearance").evaluate((e) => e.getBoundingClientRect().height);
    const c0 = await clearance();
    check((await dock.getAttribute("class")).indexOf("slim") === -1, "starts expanded");
    await b.page.evaluate(() => window.scrollTo(0, 0));
    await sleep(900);
    await api("chat", { code: game.code, text: "badge test" }, D); // an unread message (chat closed)
    await b.page.locator(".chat-dock--alert").waitFor({ timeout: 9000 });
    await b.page.waitForFunction(() => !document.querySelector(".chat-dock--alert"), null, { timeout: 8000 });
    const before = await b.page.evaluate(() => ({ h: document.documentElement.scrollHeight, top: document.querySelector("#g").getBoundingClientRect().top + window.scrollY }));
    await b.page.mouse.wheel(0, 500); await sleep(120); await b.page.mouse.wheel(0, 500);
    await b.page.waitForFunction(() => document.querySelector(".chat-dock--slim"), null, { timeout: 4000 });
    check(true, "scrolled down: the bar collapses to a slim handle");
    const slim = await dock.locator(".qs-btn").boundingBox();
    check(slim.height >= 43.5 && slim.width >= 43.5, "the 😀 button stays (≥44px)");
    check(await dock.locator(".chat-badge").isVisible(), "the unread badge stays");
    const dh = await dock.boundingBox();
    check(dh.height < 52 + 2, `the bar is slimmer (${Math.round(dh.height)}px)`);
    const after = await b.page.evaluate(() => ({ h: document.documentElement.scrollHeight, top: document.querySelector("#g").getBoundingClientRect().top + window.scrollY }));
    check(before.h === after.h && Math.abs(before.top - after.top) < 1, "the page doesn't jump (height and positions unchanged)");
    check((await clearance()) === c0, "it keeps reserving the same space");
    await shot(b.page, `s4-${vp}-dock-slim`);
    const tc = await tapCheck(b.page);
    check(tc.covered.length === 0, `slim bar: nothing covered (${tc.covered.join("; ")})`);
    await b.page.mouse.wheel(0, -300);
    await b.page.waitForFunction(() => !document.querySelector(".chat-dock--slim"), null, { timeout: 4000 });
    check(true, "scrolling up brings the full bar back");
    await b.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await sleep(900);
    check((await dock.getAttribute("class")).indexOf("slim") === -1, "stopping near the bottom shows the full bar");
    const tc2 = await tapCheck(b.page);
    check(tc2.covered.length === 0, `bottom of the page, bar expanded: nothing covered (${tc2.covered.join("; ")})`);
    await b.page.evaluate(() => window.scrollTo(0, 0));
  });

  // ---------- 1. New-notification tint / pulse; reduced motion
  if (phone) await guarded("dock pulse", async () => {
    await sleep(10500);
    await api("chat", { code: game.code, text: "pulse test" }, D);
    await b.page.locator(".chat-dock-flash").waitFor({ timeout: 9000 });
    const anim = await b.page.locator(".chat-dock-flash").evaluate((e) => getComputedStyle(e).animationName);
    check(anim === "dock-flash", `a short pulse plays on arrival (${anim})`);
    const rm = await openAs(browser, game, B, vp, { reducedMotion: true });
    await rm.page.locator("#g").waitFor({ timeout: 9000 });
    await api("chat", { code: game.code, text: "calm test" }, D);
    await rm.page.locator(".chat-dock--alert").waitFor({ timeout: 9000 });
    const anim2 = await rm.page.locator(".chat-dock-flash").evaluate((e) => getComputedStyle(e).animationName);
    const bg = await rm.page.locator(".chat-dock").evaluate((e) => getComputedStyle(e).backgroundColor);
    check(anim2 === "none", `reduced motion: no animation (${anim2})`);
    check(bg !== "rgba(0, 0, 0, 0)", `reduced motion: a plain color change (${bg})`);
    await rm.ctx.close();
  });

  // ---------- 10. "Your turn!" notice + louder beep
  await guarded("turn toast", async () => {
    await b.page.mouse.click(5, 5); await c.page.mouse.click(5, 5); // unlock (fake) audio
    // Reset to a clean round so we know the order: Ana (B) → Boro (C) → Dax (D)
    await api("endround", { code: game.code }, A);
    await pickAs(game, B, "2986"); // Ana now hosts round 2... order: Boro, Cleo(D), Hosty(A)
    let guard = 0;
    while ((await getState(game.code, C)).currentPlayerId === C.id && guard++ < 3) await wrongGuess(game, C);
    await sleep(3500); // c's page has now seen a state where it's not its turn
    check((await c.page.locator(".turn-toast").count()) === 0, "no notice when it isn't your turn");
    check((await b.page.locator(".turn-toast").count()) === 0, "never for the host (Ana hosts round 2)");
    // walk the turn around until it reaches Boro
    guard = 0;
    while ((await getState(game.code, C)).currentPlayerId !== C.id && guard++ < 6) await wrongGuess(game, C);
    await c.page.locator(".turn-toast").waitFor({ timeout: 9000 });
    const txt = (await c.page.locator(".turn-toast").innerText()).trim();
    check(/Your turn!/.test(txt), `the notice reads “${txt}”`);
    const col = await c.page.locator(".turn-toast-btn").evaluate((e) => getComputedStyle(e).backgroundColor);
    const chatCol = await c.page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--star"));
    check(col === "rgb(217, 154, 30)" || /217, 154, 30/.test(col), `it uses the game's accent color (${col}, --star ${chatCol.trim()})`);
    // the host (Ana) never gets one; any other page shows one only if it really is that player's turn
    check((await b.page.locator(".turn-toast").count()) === 0, "never for the host");
    await shot(c.page, `s4-${vp}-turn-toast-main`);
    // never over the guess controls
    const guards = await c.page.evaluate(() => {
      const t = document.querySelector(".turn-toast-btn").getBoundingClientRect();
      const inter = (r) => !(r.right <= t.left || r.left >= t.right || r.bottom <= t.top || r.top >= t.bottom);
      return [...document.querySelectorAll("[data-guard]")].filter((e) => inter(e.getBoundingClientRect())).map((e) => e.getAttribute("data-guard"));
    });
    check(guards.length === 0, `it doesn't cover the guess input / button / draft (${guards.join(",")})`);
    // gone by itself after ~3s
    await c.page.locator(".turn-toast").waitFor({ state: "detached", timeout: 5000 });
    check(true, "it disappears by itself after about 3 seconds");
    await sleep(4000);
    check((await c.page.locator(".turn-toast").count()) === 0, "and never comes back for the same turn");
    // the beep is clearly louder
    const gains = await c.page.evaluate(() => window.__audio.gains);
    const peaks = gains.map((g) => Math.max(...g));
    const beep = Math.max(...peaks);
    check(beep >= 0.29 && beep <= 0.31, `the turn beep peaks at ~0.30 (was 0.15): ${beep}`);
    // chat sound for comparison
    if (!phone) { const hide = c.page.getByRole("button", { name: "Hide" }); if (await hide.count()) await hide.click(); }
    await sleep(10500);
    await api("chat", { code: game.code, text: "sound compare" }, A);
    await c.page.waitForFunction(() => window.__audio.gains.length >= 4, null, { timeout: 9000 }).catch(() => {});
    const peaks2 = (await c.page.evaluate(() => window.__audio.gains)).map((g) => Math.max(...g));
    const chatPeak = Math.min(...peaks2.filter((p) => p < 0.2));
    check(chatPeak < 0.2 && beep >= chatPeak * 2, `clearly louder than the chat sound (${beep} vs ${chatPeak})`);

    // tap dismisses: pass the turn around again
    await passAwayThenBack(game, C, C);
    await c.page.locator(".turn-toast").waitFor({ timeout: 9000 });
    await c.page.locator(".turn-toast-btn").click();
    check((await c.page.locator(".turn-toast").count()) === 0, "tapping it dismisses it");

    // above the open scratch sheet
    await wrongGuess(game, C); // Boro guesses → someone else's turn
    await sleep(3600);
    await c.page.getByRole("button", { name: "Scratch sheet" }).first().click();
    await c.page.locator("dialog.sheet[open]").waitFor();
    guard = 0;
    while ((await getState(game.code, C)).currentPlayerId !== C.id && guard++ < 6) await wrongGuess(game, C);
    const sheetToast = c.page.locator("dialog.sheet[open] .turn-toast");
    await sheetToast.waitFor({ timeout: 9000 });
    const sb = await sheetToast.locator(".turn-toast-btn").boundingBox();
    const hit = await c.page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest(".turn-toast"), [sb.x + sb.width / 2, sb.y + sb.height / 2]);
    check(hit, "above the open scratch sheet, on top and tappable");
    const sg = await c.page.evaluate(() => {
      const t = document.querySelector("dialog.sheet[open] .turn-toast-btn").getBoundingClientRect();
      return [...document.querySelectorAll("dialog.sheet[open] [data-guard]")].filter((e) => { const r = e.getBoundingClientRect(); return !(r.right <= t.left || r.left >= t.right || r.bottom <= t.top || r.top >= t.bottom); }).length;
    });
    check(sg === 0, "and not over the draft row or Submit guess");
    await shot(c.page, `s4-${vp}-turn-toast-sheet`);
    const tcs = await tapCheck(c.page, { root: "dialog.sheet[open]" });
    check(tcs.covered.length === 0, `sheet open with the notice showing: nothing else covered (${tcs.covered.join("; ")})`);
    await c.page.locator("dialog.sheet[open] .sheet-close").click();
    await sleep(3500);

    // above the open chat (phone: the chat sheet; wide: the chat panel in the page)
    await wrongGuess(game, C);
    await sleep(3600);
    const panel = await openChatView(c.page, phone);
    void panel;
    guard = 0;
    while ((await getState(game.code, C)).currentPlayerId !== C.id && guard++ < 6) await wrongGuess(game, C);
    const chatToast = c.page.locator(phone ? "dialog.chat-sheet[open] .turn-toast" : ".turn-toast");
    await chatToast.waitFor({ timeout: 9000 });
    const cb = await chatToast.locator(".turn-toast-btn").boundingBox();
    const hit2 = await c.page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest(".turn-toast"), [cb.x + cb.width / 2, cb.y + cb.height / 2]);
    check(hit2, "above the open chat, on top and tappable");
    await shot(c.page, `s4-${vp}-turn-toast-chat`);
    if (phone) await c.page.getByRole("button", { name: "Close chat" }).click();

    // between rounds: no notice
    await api("endround", { code: game.code }, B);
    await sleep(4500);
    check((await c.page.locator(".turn-toast").count()) === 0 && (await a.page.locator(".turn-toast").count()) === 0, "nothing between rounds");

    // reduced motion
    const rm = await openAs(browser, game, C, vp, { reducedMotion: true });
    await rm.page.getByText("It's your turn to host", { exact: false }).or(rm.page.getByText("Waiting for", { exact: false })).first().waitFor({ timeout: 9000 });
    await rm.ctx.close();
  });

  check(await noHorizontalScroll(b.page), "no sideways scroll");
  await a.ctx.close(); await b.ctx.close(); await c.ctx.close();
}
