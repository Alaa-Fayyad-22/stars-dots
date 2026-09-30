import { makeGame, openAs, api, getState, pickAs, wrongGuess, check, log, shot, waitText, sleep, noHorizontalScroll } from "./lib.mjs";

// Everyone can leave; come back with the Rejoin button (same device) or name + PIN (another device).
export async function run(browser, vp) {
  log(`\n[S2 leave / come back] ${vp}`);
  const game = await makeGame({ mode: "rotating", digits: 4, count: 4 });
  const [A, B, C, D] = game.players;
  const a = await openAs(browser, game, A, vp);
  const b = await openAs(browser, game, B, vp);
  const c = await openAs(browser, game, C, vp);
  await pickAs(game, A, "4715");
  // give Boro a guess so "(away)" shows in the guess list
  for (let i = 0; i < 6; i++) {
    const s = await getState(game.code, A);
    if (s.players.find((p) => p.id === C.id).history.length) break;
    await wrongGuess(game, A);
  }
  await waitText(c.page, "Your guess");

  // ---- Boro (a normal player) leaves from the bottom of the Players section
  const leaveBtn = c.page.getByRole("button", { name: "Leave game" });
  await leaveBtn.scrollIntoViewIfNeeded();
  const box = await leaveBtn.boundingBox();
  check(box.height >= 43.5, `Leave game button is at least 44px tall (${Math.round(box.height)})`);
  await leaveBtn.click();
  await waitText(c.page, "Leave the game? You can come back anytime with your name and PIN.");
  await shot(c.page, `s2-${vp}-1-confirm`);
  await c.page.getByRole("button", { name: "Stay" }).click();
  check(await c.page.getByRole("button", { name: "Leave game" }).isVisible(), "Stay cancels the leave");
  await c.page.getByRole("button", { name: "Leave game" }).click();
  await c.page.getByRole("button", { name: "Yes, leave" }).click();
  await waitText(c.page, "You left the game. You can come back anytime.");
  check(await c.page.getByRole("button", { name: "Rejoin", exact: true }).isVisible(), "the Rejoin button is shown");
  check((await c.page.locator(".qs").count()) === 0, "no 😀 button for someone who's away");
  await shot(c.page, `s2-${vp}-2-left-screen`);
  const st = await getState(game.code, A);
  check(!st.currentPlayerId || st.currentPlayerId !== C.id, "an away player never has the turn");
  await waitText(b.page, "Boro (away)", 9000).catch(() => {});
  check((await b.page.getByText("Boro (away)").count()) > 0, "others see Boro marked (away) in the player list / guesses");
  check((await b.page.locator(".guess-feed-name", { hasText: "(away)" }).count()) > 0, "and in the guess list");

  // chat: the away player's earlier messages are labeled too
  // ---- Rejoin on the same device: no PIN
  await c.page.getByRole("button", { name: "Rejoin", exact: true }).click();
  await c.page.locator("#g").waitFor({ timeout: 9000 });
  check((await c.page.getByText("You left the game").count()) === 0, "back in the game after Rejoin");
  const st2 = await getState(game.code, C);
  check(st2.me && !st2.me.removed && !st2.isHost && !st2.isControlsHolder, "a normal player again (never host or controls)");
  check((await c.page.locator(".qs").count()) > 0, "the 😀 button is back");
  check(!!(await c.page.getByText("Boro (away)").count()) === false, "no longer marked away");

  // ---- Cleo leaves (API), comes back from a FRESH context with name + PIN
  await api("leave", { code: game.code }, D);
  const fresh = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const fp = await fresh.newPage();
  await fp.goto(`http://127.0.0.1:3100/game/${game.code}`);
  await fp.getByRole("tab", { name: "Already in this game?" }).waitFor({ timeout: 9000 });
  await fp.getByRole("tab", { name: "Already in this game?" }).click();
  await fp.locator("#rn").selectOption({ label: "Cleo (away)" });
  await fp.fill("#rp", "9999");
  await fp.getByRole("button", { name: "Rejoin" }).last().click();
  await waitText(fp, "Wrong PIN", 6000);
  check(true, "a wrong PIN is refused on the other device");
  await fp.fill("#rp", "1111");
  await fp.getByRole("button", { name: "Rejoin" }).last().click();
  await fp.locator("#g").waitFor({ timeout: 9000 });
  check(true, "Cleo is back with name + PIN on another device");
  const tokenSaved = await fp.evaluate((code) => localStorage.getItem(`sd:${code}`), game.code);
  check(/"token":"[0-9a-f]{64}"/.test(tokenSaved || ""), "the new device stored id + token");
  await shot(fp, `s2-${vp}-3-cleo-back`);
  await fresh.close();

  // ---- the host leaves mid-round from Host controls, and comes back
  await a.page.getByRole("button", { name: /Host controls/ }).scrollIntoViewIfNeeded();
  await a.page.getByRole("button", { name: /Host controls/ }).click();
  await a.page.getByRole("button", { name: "Leave game" }).click();
  await a.page.getByRole("button", { name: "Yes, leave" }).click();
  await waitText(a.page, "You left the game. You can come back anytime.");
  const room = await getState(game.code, B);
  check(room.hostId === null && room.roundState === "active", "the round goes hostless");
  check(room.secret === null, "and nobody holds the number");
  await a.page.getByRole("button", { name: "Rejoin", exact: true }).click();
  await a.page.locator("#g").waitFor({ timeout: 9000 });
  const back = await getState(game.code, A);
  check(!back.isHost && !back.isControlsHolder && back.secret === null, "the former host is a normal player and sees no number");

  // leaving and coming back several times
  for (let i = 0; i < 3; i++) {
    await api("leave", { code: game.code }, B);
    await api("comeback", { code: game.code }, B);
  }
  const fin = await getState(game.code, B);
  check(fin.me && !fin.me.removed, "leaving/coming back repeatedly still works");
  check(await noHorizontalScroll(c.page), "no sideways scroll");
  await a.ctx.close(); await b.ctx.close(); await c.ctx.close();
}
