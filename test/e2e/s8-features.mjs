import {
  makeGame, openAs, api, getState, pickAs, check, log, shot, waitText, sleep, tapCheck, noHorizontalScroll, BASE, VIEWPORTS,
} from "./lib.mjs";

// Colors everywhere, replays from the Rounds table (including an old round with no
// details), the sound settings, "Summary so far" and the Game over screen.
// Run (with the app up as described in lib.mjs): node test/e2e/run.mjs s8-features

const FAKE = process.env.FAKE_DB || "http://127.0.0.1:8791";
const redisDel = (key) => fetch(FAKE, { method: "POST", body: JSON.stringify(["del", key]) }).then((r) => r.json());

const distinctColors = async (page, selector) =>
  page.evaluate((sel) => {
    const els = [...document.querySelectorAll(sel)].filter((e) => e.getBoundingClientRect().width > 0);
    return els.map((e) => getComputedStyle(e).backgroundColor);
  }, selector);

// Round 1: Hosty hosts, Cleo wins. Round 2: Ana hosts, ended with no winner. Round 3: Boro to pick.
async function playTwoRounds(game) {
  const [H, A, B, C] = game.players;
  await pickAs(game, H, "4715");
  await api("guess", { code: game.code, guess: "1234" }, A);
  await api("guess", { code: game.code, guess: "5678" }, B);
  await api("guess", { code: game.code, guess: "4715" }, C); // Cleo: win
  await pickAs(game, A, "8236");
  await api("guess", { code: game.code, guess: "1357" }, B);
  await api("guess", { code: game.code, guess: "9024" }, C);
  await api("endround", { code: game.code }, A); // no winner
  return { H, A, B, C };
}

async function dialogTap(page, tag, vp) {
  const r = await tapCheck(page, { root: "dialog[open]" });
  check(r.covered.length === 0, `${tag}: nothing covered in the dialog [${r.checked} checked] ${r.covered.join("; ")}`);
  const small = r.small.filter((s) => !/modal-body/.test(s));
  check(small.length === 0, `${tag}: tap targets >= 44px ${small.join("; ")}`);
  check(await noHorizontalScroll(page), `${tag}: no sideways scroll`);
  void vp;
}

export async function run(browser, vp) {
  log(`\n[S8 colors, replays, summary, sound, game over] ${vp}`);
  const phone = vp === "phone";
  for (const dark of [false, true]) {
    const tag = `${vp}${dark ? "-dark" : ""}`;
    const game = await makeGame({ mode: "rotating", digits: 4, count: 4 });
    const { H, A, B, C } = await playTwoRounds(game);
    const c = await openAs(browser, game, C, vp, { dark });
    const page = c.page;
    await page.getByRole("heading", { name: "Players (4)" }).waitFor({ timeout: 9000 });

    // ---- Feature 1: colors everywhere ----
    const st = await getState(game.code, C);
    check(st.players.every((p) => Number.isInteger(p.color)), `${tag}: every player has a color`);
    check(new Set(st.players.map((p) => p.color)).size === 4, `${tag}: four different colors for four people`);
    const listColors = await distinctColors(page, ".players .swatch");
    check(listColors.length === 4 && new Set(listColors).size === 4, `${tag}: the player list shows 4 different colors (${listColors.length})`);
    check((await page.locator(".scoreboard-table .scoreboard-name .swatch").count()) >= 4, `${tag}: the scoreboard shows colors`);
    check((await page.locator(".rounds-table .swatch").count()) >= 1, `${tag}: the Rounds table shows the winner's color`);
    // every name in the list also has its text (color is never alone)
    for (const n of ["Hosty", "Ana", "Boro", "Cleo"]) check((await page.locator(".players .who-name-text", { hasText: n }).count()) === 1, `${tag}: ${n} is named`);
    // The same color for the same person in the list and in the guess list
    const colorOfInList = async (name) => page.locator(".players li", { hasText: name }).locator(".swatch").evaluate((e) => getComputedStyle(e).backgroundColor);
    // a fresh guess so the main guess feed has entries (Boro hosts round 3: pick, then guesses)
    await pickAs(game, B, "2468");
    await api("guess", { code: game.code, guess: "1357" }, H);
    await sleep(3300);
    await page.locator(".guess-feed-item").first().waitFor({ timeout: 9000 });
    const feedColor = await page.locator(".guess-feed-item", { hasText: "Hosty" }).first().locator(".swatch").evaluate((e) => getComputedStyle(e).backgroundColor);
    check(feedColor === (await colorOfInList("Hosty")), `${tag}: Hosty has the same color in the guess list and the player list`);
    await shot(page, `s8-${tag}-main`);

    // scratch sheet rows
    await page.getByRole("button", { name: "Scratch sheet" }).first().click();
    await page.locator("dialog.sheet[open]").waitFor();
    check((await page.locator("dialog.sheet[open] .sheet-name .swatch").count()) >= 1, `${tag}: the scratch sheet rows show colors`);
    await shot(page, `s8-${tag}-sheet`);
    await page.locator("dialog.sheet[open] .sheet-close").click();
    await sleep(300);

    // chat message + notification colors
    await api("chat", { code: game.code, text: "hello from Ana" }, A);
    if (phone) await page.locator(".chat-dock--alert .swatch").first().waitFor({ timeout: 9000 }).then(() => check(true, ""), () => check(false, `${tag}: the chat bar notification shows the sender's color`));
    else await page.locator(".chat-toast .swatch").first().waitFor({ timeout: 9000 }).then(() => check(true, ""), () => check(false, `${tag}: the notification shows the sender's color`));
    await shot(page, `s8-${tag}-notif`);
    await (phone ? page.locator(".chat-dock-btn") : page.locator(".chat-toast-open").first()).click();
    await page.locator(".chat-msg .swatch").first().waitFor({ timeout: 6000 });
    check(true, `${tag}: chat messages show the sender's color`);
    await shot(page, `s8-${tag}-chat`);
    if (phone) await page.locator(".chat-sheet-close").click(); else await page.getByRole("button", { name: "Hide" }).click().catch(() => {});
    await sleep(300);

    // ---- Feature 2: replays ----
    const rows = page.locator(".rounds-table tbody tr");
    check((await rows.count()) === 2, `${tag}: two finished rounds in the Rounds table`);
    check((await page.locator(".rounds-table .rounds-view").count()) === 2, `${tag}: every row has a visible "View" button`);
    // Round 1: the whole row is tappable
    await rows.filter({ hasText: "4715" }).first().scrollIntoViewIfNeeded();
    await rows.filter({ hasText: "4715" }).first().click();
    const dlg = page.locator("dialog.modal--replay[open]");
    await dlg.waitFor({ timeout: 6000 });
    await dlg.getByText("Winning guess").waitFor({ timeout: 6000 });
    check((await dlg.locator(".replay-numbers .tile--lg").allInnerTexts()).join("") === "4715", `${tag}: replay shows the number in big tiles`);
    check((await dlg.locator(".replay-guess").count()) === 3, `${tag}: all 3 guesses listed`);
    check((await dlg.locator(".replay-guess--win").count()) === 1, `${tag}: the winning guess is highlighted`);
    check((await dlg.locator(".replay-n").allInnerTexts()).join() === "1,2,3", `${tag}: guesses numbered in order`);
    check((await dlg.locator(".replay-name").allInnerTexts()).map((s) => s.trim().split(" ")[0]).join() === "Ana,Boro,Cleo", `${tag}: in the order they were made, with names`);
    check((await dlg.locator(".replay-name .swatch").count()) === 3, `${tag}: with colors`);
    check((await dlg.locator(".digit-legend li").count()) === 3, `${tag}: with a legend`);
    check((await dlg.locator(".replay-guess").last().locator(".tile--right").count()) === 4, `${tag}: the winning guess is all "right place"`);
    check((await dlg.locator(".replay-guess").first().locator(".tile--right, .tile--wrong, .tile--none").count()) === 4, `${tag}: every digit of a guess is classified`);
    const meta = await dlg.locator(".replay-meta").innerText();
    check(/Cleo/.test(meta) && /Hosty/.test(meta), `${tag}: winner and host shown (${meta.replace(/\s+/g, " ")})`);
    await sleep(450);
    await shot(page, `s8-${tag}-replay`);
    await dialogTap(page, `${tag} replay`, vp);
    await page.keyboard.press("Escape");
    await dlg.waitFor({ state: "detached", timeout: 3000 });
    // Round 2 (ended, no winner): opened with the keyboard
    const viewBtn2 = rows.filter({ hasText: "8236" }).locator(".rounds-view");
    await viewBtn2.focus();
    await page.keyboard.press("Enter");
    await dlg.waitFor({ timeout: 6000 });
    check(/No winner/.test(await dlg.locator(".replay-meta").innerText()), `${tag}: an ended round says "No winner"`);
    await page.keyboard.press("Escape");
    await dlg.waitFor({ state: "detached", timeout: 3000 });
    // An old round (no details saved): a friendly message, not an error
    await redisDel(`room:${game.code}:rounddetails`);
    await rows.filter({ hasText: "4715" }).locator(".rounds-view").click();
    await dlg.getByText("Details not available for this round.").waitFor({ timeout: 6000 });
    check((await dlg.locator(".error").count()) === 0, `${tag}: no error for an old round`);
    await sleep(450);
    await shot(page, `s8-${tag}-replay-old`);
    await page.keyboard.press("Escape");
    await dlg.waitFor({ state: "detached", timeout: 3000 });

    // ---- Feature 3: Summary so far ----
    await page.locator(".summary-open").first().scrollIntoViewIfNeeded();
    await page.locator(".summary-open").first().click();
    const sdlg = page.locator("dialog.modal--summary[open]");
    await sdlg.waitFor({ timeout: 6000 });
    await sdlg.locator(".award").first().waitFor({ timeout: 6000 }).catch(() => {});
    check((await sdlg.locator(".standing").count()) === 4, `${tag}: summary lists 4 standings`);
    check((await sdlg.locator(".standing .swatch").count()) === 4, `${tag}: with colors`);
    const awardsText = await sdlg.locator(".awards").innerText().catch(() => "");
    check(/most wins/i.test(awardsText) && /Cleo/.test(awardsText), `${tag}: awards include Most wins -> Cleo`);
    await sleep(450);
    await shot(page, `s8-${tag}-summary`);
    await dialogTap(page, `${tag} summary`, vp);
    await page.keyboard.press("Escape");
    await sdlg.waitFor({ state: "detached", timeout: 3000 });

    // ---- Feature 4: sound settings ----
    const speaker = page.getByRole("button", { name: /^Sound settings/ });
    check((await speaker.getAttribute("aria-label")) === "Sound settings", `${tag}: the speaker shows the normal icon when both sounds are on`);
    await speaker.scrollIntoViewIfNeeded();
    await speaker.click();
    const pop = page.locator(".sound-pop");
    await pop.waitFor();
    const sw = pop.getByRole("switch");
    check((await sw.count()) === 2, `${tag}: two switches`);
    check((await pop.innerText()).includes("Chat sounds") && (await pop.innerText()).includes("Turn alert sound"), `${tag}: labeled "Chat sounds" and "Turn alert sound"`);
    check((await sw.nth(0).getAttribute("aria-checked")) === "true" && (await sw.nth(1).getAttribute("aria-checked")) === "true", `${tag}: both on by default`);
    const box = await pop.boundingBox();
    const vw = VIEWPORTS[vp].viewport.width;
    check(box.x >= 0 && box.x + box.width <= vw, `${tag}: the popover fits the screen (${Math.round(box.x)}..${Math.round(box.x + box.width)} of ${vw})`);
    await shot(page, `s8-${tag}-sound`);
    const rp = await tapCheck(page, { root: ".sound-pop" });
    check(rp.covered.length === 0 && rp.small.length === 0, `${tag}: sound popover targets are tappable ${rp.covered.join("; ")} ${rp.small.join("; ")}`);
    await sw.nth(0).click();
    check((await sw.nth(0).getAttribute("aria-checked")) === "false" && (await sw.nth(1).getAttribute("aria-checked")) === "true", `${tag}: each switch is independent`);
    check((await speaker.getAttribute("aria-label")) === "Sound settings (some sounds are off)", `${tag}: the muted icon shows when any sound is off`);
    await page.keyboard.press("Escape");
    check((await page.locator(".sound-pop").count()) === 0, `${tag}: Escape closes it`);
    check((await page.evaluate(() => [localStorage.getItem("sd:sound-chat"), localStorage.getItem("sd:sound-turn")].join())) === "0,", `${tag}: saved on the device`);
    await page.reload();
    await page.getByRole("heading", { name: "Players (4)" }).waitFor({ timeout: 9000 });
    check((await page.getByRole("button", { name: /^Sound settings/ }).getAttribute("aria-label")) === "Sound settings (some sounds are off)", `${tag}: still muted after a reload`);
    await page.getByRole("button", { name: /^Sound settings/ }).click();
    check((await page.locator(".sound-pop").getByRole("switch").nth(0).getAttribute("aria-checked")) === "false", `${tag}: the setting persisted`);
    await page.locator(".sound-pop").getByRole("switch").nth(0).click(); // back on
    await page.keyboard.press("Escape");

    // ---- Feature 3: End game -> Game over ----
    const host = await openAs(browser, game, B, vp, { dark }); // Boro hosts round 3
    await host.page.getByRole("button", { name: /Host controls/ }).waitFor({ timeout: 9000 });
    check((await c.page.getByRole("button", { name: "End game" }).count()) === 0, `${tag}: a plain player has no End game button`);
    await host.page.getByRole("button", { name: /Host controls/ }).scrollIntoViewIfNeeded();
    if ((await host.page.getByRole("button", { name: /Host controls/ }).getAttribute("aria-expanded")) !== "true") await host.page.getByRole("button", { name: /Host controls/ }).click();
    await host.page.getByRole("button", { name: "End game", exact: true }).click();
    await host.page.getByText("End the game for everyone? No more rounds can be played.").waitFor();
    await shot(host.page, `s8-${tag}-endgame-confirm`);
    await host.page.getByRole("button", { name: "Cancel" }).click();
    check((await getState(game.code, C)).gameOver !== true, `${tag}: Cancel keeps playing`);
    await host.page.getByRole("button", { name: "End game", exact: true }).click();
    await host.page.getByRole("button", { name: "Yes, end game" }).click();
    await waitText(host.page, "Game over", 9000);
    await waitText(page, "Game over", 9000);
    await page.locator(".award").first().waitFor({ timeout: 9000 });
    const cardBox = await page.locator(".gameover-card").boundingBox();
    const vh = VIEWPORTS[vp].viewport.height;
    log(`  (info) ${tag}: Game over card is ${Math.round(cardBox.height)}px tall in a ${vh}px screen`);
    if (phone) check(cardBox.y + cardBox.height <= vh - 54, `${tag}: the Game over card fits one phone screen (ends at ${Math.round(cardBox.y + cardBox.height)} of ${vh})`);
    check((await page.locator(".gameover .standing .swatch").count()) === 4, `${tag}: final standings with colors`);
    const awardNames = (await page.locator(".award-title").allTextContents());
    // (the saved details were deleted above to imitate an old game, so details-based awards like "Fastest solve" are correctly absent)
    check(awardNames.includes("Most wins") && awardNames.includes("Most guesses made") && awardNames.includes("Most rounds hosted") && !awardNames.includes("Fastest solve"), `${tag}: awards ${awardNames.join(" / ")}`);
    check((await page.locator(".award .swatch").count()) >= awardNames.length, `${tag}: each award shows a winner's color`);
    const stats = await page.locator(".summary-stats").innerText();
    check(/3\s+rounds played/.test(stats), `${tag}: rounds played counted (${stats.replace(/\s+/g, " ")})`);
    check((await page.getByRole("link", { name: "Start a new game" }).getAttribute("href")) === "/", `${tag}: "Start a new game"`);
    await shot(page, `s8-${tag}-gameover`);
    let rt = await tapCheck(page);
    check(rt.covered.length === 0, `${tag}: Game over screen: nothing covered [${rt.checked} checked] ${rt.covered.join("; ")}`);
    check(await noHorizontalScroll(page), `${tag}: Game over: no sideways scroll`);
    // rounds + replays from the Game over screen
    await page.getByRole("button", { name: /Rounds & replays/ }).click();
    await page.locator(".gameover-rounds .rounds-row").first().waitFor();
    check((await page.locator(".gameover-rounds .rounds-row").count()) === 3, `${tag}: all 3 rounds listed (the game-ending one too)`);
    await page.locator(".gameover-rounds .rounds-row").first().click();
    await dlg.waitFor({ timeout: 6000 });
    check(/ended during this round/.test(await dlg.locator(".replay-meta").innerText()), `${tag}: the round the game ended in says so`);
    await shot(page, `s8-${tag}-gameover-replay`);
    await page.keyboard.press("Escape");
    await dlg.waitFor({ state: "detached", timeout: 3000 });
    // nothing can be played any more, and nobody new can join
    const after = await api("guess", { code: game.code, guess: "1357" }, A);
    check(after.status >= 400, `${tag}: guesses are refused after the game`);
    const late = await api("join", { code: game.code, name: "Latecomer", pin: "1111" });
    check(late.status >= 400, `${tag}: nobody can join after the game`);
    // The loser's Rejoin / chat still work on this screen
    check((await page.locator(".chat-dock, .qs--corner, .chat-section").count()) > 0, `${tag}: chat stays available`);
    await host.ctx.close(); await c.ctx.close();
  }
  await runSound(browser, vp);
  await runFullGameOver(browser, vp);
}

// --- Sound: each switch silences only its own sound ---
export async function runSound(browser, vp) {
  log(`\n[S8b sound switches silence only their own sound] ${vp}`);
  for (const [chatOn, turnOn] of [[true, true], [false, true], [true, false], [false, false]]) {
    const tag = `${vp} chat:${chatOn ? "on" : "off"} turn:${turnOn ? "on" : "off"}`;
    const game = await makeGame({ mode: "computer", digits: 3, count: 3 });
    const [A, B, C] = game.players;
    const ctx = await browser.newContext({ ...VIEWPORTS[vp], reducedMotion: "no-preference" });
    await ctx.addInitScript(([chat, turn, code, id, token]) => {
      try {
        localStorage.setItem(`sd:${code}`, JSON.stringify({ id, token }));
        if (!chat) localStorage.setItem("sd:sound-chat", "0");
        if (!turn) localStorage.setItem("sd:sound-turn", "0");
      } catch {}
      window.__audio = { gains: 0 };
      window.__vib = 0;
      navigator.vibrate = () => { window.__vib++; return true; };
      class FakeAC {
        constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
        resume() {}
        createOscillator() { return { frequency: { value: 0 }, type: "", connect() {}, start() {}, stop() {} }; }
        createGain() { window.__audio.gains++; return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
        createBufferSource() { window.__audio.gains++; return { connect() {}, start() {} }; }
        decodeAudioData(d, ok) { ok && ok(null); }
      }
      window.AudioContext = FakeAC;
    }, [chatOn, turnOn, game.code, B.id, B.token]);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/game/${game.code}`);
    await page.getByRole("heading", { name: /Players \(3\)/ }).waitFor({ timeout: 9000 });
    await page.mouse.click(5, 5); // unlock audio, as a real tap would
    await sleep(300);
    const read = () => page.evaluate(() => ({ gains: window.__audio.gains, vib: window.__vib }));
    const s0 = await read();

    // A chat message from someone else (the page may be on screen: notification appears either way)
    await api("chat", { code: game.code, text: "ping" }, C);
    await page.locator(vp === "phone" ? ".chat-dock--alert" : ".chat-toast").first().waitFor({ timeout: 9000 });
    await sleep(300);
    const s1 = await read();
    check(s1.gains - s0.gains === (chatOn ? 2 : 0), `${tag}: a chat message plays ${chatOn ? "its sound" : "no sound"} (gains +${s1.gains - s0.gains})`);
    check((await page.locator(vp === "phone" ? ".chat-dock--alert" : ".chat-toast").count()) > 0, `${tag}: and the notification appears anyway`);

    // My turn: A guesses (turn order A, B, C) -> B's turn
    await api("guess", { code: game.code, guess: "123" }, A);
    await page.getByText("Your turn!").first().waitFor({ timeout: 9000 }).catch(() => {});
    await sleep(300);
    const s2 = await read();
    check(s2.gains - s1.gains === (turnOn ? 1 : 0), `${tag}: "Your turn" plays ${turnOn ? "the beep" : "no beep"} (gains +${s2.gains - s1.gains})`);
    check(s2.vib - s1.vib === 1, `${tag}: and vibrates either way (+${s2.vib - s1.vib})`);
    check((await page.getByText("Your turn!").count()) > 0, `${tag}: and the "Your turn!" notice still shows`);
    await ctx.close();
  }
}

// --- The Game over card with every award and six players must still fit one phone screen ---
export async function runFullGameOver(browser, vp) {
  log(`\n[S8c Game over with all six awards and six players] ${vp}`);
  const game = await makeGame({ mode: "rotating", digits: 4, count: 6 });
  const byId = Object.fromEntries(game.players.map((p) => [p.id, p]));
  const misses = ["1235", "2341", "5678", "4321", "9876"];
  for (let round = 0; round < 3; round++) {
    const st = await getState(game.code, game.players[0]);
    const host = byId[st.hostId];
    await pickAs(game, host, "1234");
    for (let k = 0; ; k++) {
      const s = await getState(game.code, game.players[0]);
      if (s.roundState !== "active") break;
      const who = byId[s.currentPlayerId];
      const g = k === 2 + round ? "1234" : misses[k % misses.length];
      const r = await api("guess", { code: game.code, guess: g }, who);
      if (r.error && !/already tried/.test(r.error)) throw new Error(`guess failed: ${r.error}`);
    }
  }
  const host = byId[(await getState(game.code, game.players[0])).hostId];
  await api("endgame", { code: game.code }, host);
  for (const dark of [false, true]) {
    const tag = `${vp}${dark ? "-dark" : ""}`;
    const o = await openAs(browser, game, game.players[2], vp, { dark });
    await o.page.locator(".award").first().waitFor({ timeout: 9000 });
    const titles = await o.page.locator(".award-title").allTextContents();
    check(titles.length === 6, `${tag}: all six awards present (${titles.join(" / ")})`);
    check((await o.page.locator(".standing").count()) === 6, `${tag}: six standings`);
    const box = await o.page.locator(".gameover-card").boundingBox();
    log(`  (info) ${tag}: full Game over card: ${Math.round(box.y)}..${Math.round(box.y + box.height)} of ${VIEWPORTS[vp].viewport.height}`);
    if (vp === "phone") check(box.y + box.height <= VIEWPORTS.phone.viewport.height - 54, `${tag}: even with six awards and six players it fits one phone screen (ends at ${Math.round(box.y + box.height)})`);
    check(await noHorizontalScroll(o.page), `${tag}: no sideways scroll`);
    await sleep(300);
    await shot(o.page, `s8-${tag}-gameover-full`);
    const rt = await tapCheck(o.page);
    check(rt.covered.length === 0, `${tag}: full Game over: nothing covered ${rt.covered.join("; ")}`);
    await o.ctx.close();
  }
}
