import { VIEWPORTS, BASE, api, getState, check, log, shot, waitText, sleep, tapCheck, noHorizontalScroll } from "./lib.mjs";

// A full duel with two browser contexts: creating it from the home page, an invited
// second player, a refused third person, picking numbers, alternating turns, the fair
// ending (win, draw), reveal, Rounds table + replay, leaving and coming back, End game.
// Run: node test/e2e/run.mjs s9-duel

async function newCtx(browser, vp, dark) {
  const ctx = await browser.newContext({
    ...VIEWPORTS[vp],
    permissions: ["clipboard-read", "clipboard-write"],
    reducedMotion: "no-preference",
    colorScheme: dark ? "dark" : "light",
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 200)));
  return { ctx, page };
}

const pick = async (page, secret) => {
  await page.locator("#pick").fill(secret);
  await page.getByRole("button", { name: "Lock in my number" }).click();
};
const guess = async (page, g) => {
  await page.locator("#g").fill(g);
  await page.getByRole("button", { name: "Check guess" }).click();
};
const banner = (page) => page.locator(".turn-banner").first();
const bannerHas = async (page, text, timeout = 9000) => {
  await page.locator(".turn-banner", { hasText: text }).first().waitFor({ timeout });
};

async function tapAll(page, label, root = "body") {
  const r = await tapCheck(page, { root });
  check(r.covered.length === 0, `${label}: nothing covered [${r.checked} checked] ${r.covered.join("; ")}`);
  check(await noHorizontalScroll(page), `${label}: no sideways scroll`);
  return r;
}

export async function run(browser, vp) {
  log(`\n[S9 duel] ${vp}`);
  for (const dark of vp === "phone" ? [false, true] : [false, true]) {
    const tag = `${vp}${dark ? "-dark" : ""}`;
    const a = await newCtx(browser, vp, dark);
    const A = a.page;

    // ---- create it from the home page ----
    await A.goto(BASE);
    await A.locator("#hn").fill("Ana");
    await A.locator("#hp").fill("1111");
    const duelCard = A.getByRole("button", { name: /^Duel/ });
    check((await duelCard.innerText()).includes("2 players. Each picks a secret number and cracks the other's."), `${tag}: the Duel card says what it is`);
    await duelCard.click();
    check((await duelCard.getAttribute("aria-pressed")) === "true", `${tag}: Duel is selected`);
    await A.getByRole("button", { name: "4 digits" }).click();
    await shot(A, `s9-${tag}-create`);
    await A.getByRole("button", { name: "Create game" }).click();
    await A.waitForURL(/\/game\//);
    const code = A.url().split("/game/")[1].toUpperCase();
    await bannerHas(A, "Waiting for an opponent to join");
    check((await A.getByText("Duel", { exact: false }).count()) > 0, `${tag}: the game says it's a Duel`);
    await shot(A, `s9-${tag}-waiting-opponent`);
    await tapAll(A, `${tag} waiting for an opponent`);

    // ---- the invited player joins from the link ----
    const b = await newCtx(browser, vp, dark);
    const B = b.page;
    await B.goto(`${BASE}/game/${code}`);
    await B.locator("#n").fill("Ben");
    await B.locator("#np").fill("2222");
    await B.getByRole("button", { name: "Join game" }).click();
    await bannerHas(B, "Pick your secret number");
    await bannerHas(A, "Pick your secret number", 9000);

    // ---- a third person is refused ----
    const c = await newCtx(browser, vp, dark);
    const C = c.page;
    await C.goto(`${BASE}/game/${code}`);
    await C.locator("#n").fill("Cleo");
    await C.locator("#np").fill("3333");
    await C.getByRole("button", { name: "Join game" }).click();
    await C.getByText("This duel is full.").waitFor({ timeout: 6000 });
    await shot(C, `s9-${tag}-full`);
    await tapAll(C, `${tag} duel full`);
    await c.ctx.close();

    // ---- both pick; the round starts when both have ----
    await shot(A, `s9-${tag}-pick`);
    await tapAll(A, `${tag} pick screen`);
    await pick(A, "1234");
    await bannerHas(A, "Waiting for Ben to pick their number");
    check((await A.getByText("Your number").count()) > 0, `${tag}: Ana can see her own number`);
    await shot(A, `s9-${tag}-waiting-pick`);
    await B.getByText("Ana has picked their number.").waitFor({ timeout: 9000 }); // a note above the banner
    await pick(B, "5678");
    await bannerHas(A, "Your turn — guess Ben's number!");
    await bannerHas(B, "Waiting for Ana");
    check(!(await B.content()).includes("1234") && !(await A.content()).includes("5678"), `${tag}: neither page contains the other's number`);
    check(!JSON.stringify(await getStateFor(A, code)).includes('"5678"'), `${tag}: Ana's state has no Ben number`);
    await shot(A, `s9-${tag}-active-mine`);
    await shot(B, `s9-${tag}-active-theirs`);
    await tapAll(A, `${tag} active, my turn`);
    await tapAll(B, `${tag} active, waiting`);
    check((await A.getByRole("heading", { name: "Your guesses at Ben's number" }).count()) === 1, `${tag}: "Your guesses at Ben's number"`);
    check((await A.getByRole("heading", { name: "Ben's guesses at your number" }).count()) === 1, `${tag}: "Ben's guesses at your number"`);
    check((await B.getByRole("heading", { name: "Your guesses at Ana's number" }).count()) === 1, `${tag}: Ben sees "Your guesses at Ana's number"`);

    // ---- turns alternate; the same guess is fine for the other player ----
    await guess(A, "1357");
    await bannerHas(A, "Waiting for Ben");
    await bannerHas(B, "Your turn — guess Ana's number!");
    await guess(B, "1357");
    await B.locator(".duel-list", { hasText: "Your guesses at Ana's number" }).locator(".row").first().waitFor();
    await bannerHas(A, "Your turn", 9000);
    check((await A.locator(".duel-list", { hasText: "Ben's guesses at your number" }).locator(".row").count()) === 1, `${tag}: Ana sees Ben's guess at her number`);
    // The scratch sheet lists only my own guesses in a duel (Ben's are aimed at a different number)
    await A.getByRole("button", { name: "Scratch sheet" }).first().click();
    await A.locator("dialog.sheet[open]").waitFor();
    check((await A.locator("dialog.sheet[open] .sheet-list .sheet-row:not(.sheet-draft-row)").count()) === 1, `${tag}: the scratch sheet shows only my guesses`);
    check((await A.locator("dialog.sheet[open] .sheet-name .swatch").count()) === 1, `${tag}: with my color`);
    await A.locator("dialog.sheet[open] .sheet-close").click();
    await sleep(300);
    // A repeats her own guess: warned
    await A.locator("#g").fill("1357");
    await A.getByText("You already tried this").waitFor({ timeout: 3000 });
    await A.locator("#g").fill("");

    // ---- fair ending: first player cracks, second gets a final turn and misses ----
    await guess(A, "5678");
    await bannerHas(A, "You cracked Ben's number! Ben gets one final turn.");
    await bannerHas(B, "Final turn!", 9000);
    await shot(B, `s9-${tag}-final-turn`);
    await guess(B, "2468");
    await bannerHas(A, "You won this round", 9000);
    await bannerHas(B, "Ana won this round", 9000);
    const revealed = async (p) => ((await p.locator(".duel-reveal .tile").allInnerTexts()).join("").match(/.{4}/g) || []).sort().join();
    check((await revealed(A)) === "1234,5678", `${tag}: both numbers revealed to Ana`);
    check((await revealed(B)) === "1234,5678", `${tag}: ...and to Ben`);
    await shot(A, `s9-${tag}-round1-won`);
    await shot(B, `s9-${tag}-round1-lost`);
    await tapAll(A, `${tag} round over (winner)`);
    await tapAll(B, `${tag} round over (loser)`);
    // Rounds table shows both numbers, labeled
    const row = A.locator(".rounds-table tbody tr").first();
    await row.waitFor();
    check(/Ana\s*1234/.test(await row.innerText()) && /Ben\s*5678/.test(await row.innerText()), `${tag}: the Rounds table shows both numbers, labeled (${(await row.innerText()).replace(/\s+/g, " ")})`);
    await row.click();
    const dlg = A.locator("dialog.modal--replay[open]");
    await dlg.waitFor();
    await dlg.getByText("Winning guess").waitFor();
    check((await dlg.locator(".replay-number").count()) === 2, `${tag}: replay shows both numbers`);
    check(/Ana's number/.test(await dlg.locator(".replay-numbers").innerText()) && /Ben's number/.test(await dlg.locator(".replay-numbers").innerText()), `${tag}: labeled with whose they are`);
    check((await dlg.locator(".replay-guess").count()) === 4, `${tag}: all 4 guesses`);
    check(/→ Ben's number/.test(await dlg.locator(".replay-guess").first().innerText()), `${tag}: each guess says whose number it was aimed at`);
    await sleep(450);
    await shot(A, `s9-${tag}-replay`);
    await tapAll(A, `${tag} duel replay`, "dialog[open]");
    await A.keyboard.press("Escape");

    // ---- round 2: Ben goes first; both crack on the same turn: a draw ----
    await A.getByRole("button", { name: "Next round" }).click();
    await bannerHas(A, "Pick your secret number");
    await bannerHas(B, "Pick your secret number", 9000);
    await pick(B, "5678"); await pick(A, "1234");
    await bannerHas(B, "Your turn — guess Ana's number!", 9000);
    await bannerHas(A, "Waiting for Ben");
    check(true, `${tag}: the other player goes first in round 2`);
    await guess(B, "1234");
    await bannerHas(A, "Final turn!", 9000);
    await guess(A, "5678");
    await bannerHas(A, "It's a draw", 9000);
    await bannerHas(B, "It's a draw", 9000);
    check((await A.locator(".rounds-table tbody tr").first().innerText()).includes("Draw"), `${tag}: the Rounds table says Draw`);
    check((await A.locator(".scoreboard-table tbody tr").evaluateAll((rows) => rows.map((r) => r.innerText.replace(/\s+/g, " ")))).join("|").match(/Ana.*1/) !== null, `${tag}: a draw counts for nobody (scoreboard unchanged)`);
    const sb = (await getState(code, null)).scoreboard;
    check(sb.find((e) => e.name === "Ana").wins === 1 && sb.find((e) => e.name === "Ben").wins === 0, `${tag}: Ana 1 win, Ben 0`);
    await shot(A, `s9-${tag}-draw`);

    // ---- round 3: leave and come back ----
    await B.getByRole("button", { name: "Next round" }).click();
    await bannerHas(A, "Pick your secret number", 9000);
    await pick(A, "1234");
    await B.getByRole("button", { name: /Duel controls/ }).scrollIntoViewIfNeeded();
    await openControls(B);
    await B.getByRole("button", { name: "Leave game" }).click();
    await B.getByRole("button", { name: "Yes, leave" }).click();
    await B.getByText("You left the game. You can come back anytime.").waitFor({ timeout: 9000 });
    await bannerHas(A, "Ben left the duel. Waiting for them to come back.", 9000);
    check(await A.getByRole("button", { name: "End game", exact: true }).first().isVisible(), `${tag}: the other player can end the game right there, without opening any controls`);
    await shot(A, `s9-${tag}-opponent-left`);
    await openControls(A);
    check((await A.getByRole("button", { name: /Remove|Restore|Skip/ }).count()) === 0, `${tag}: no Remove, Restore or Skip turn in a duel`);
    await tapAll(A, `${tag} opponent left, controls open`);
    await tapAll(B, `${tag} away screen`);
    await B.getByRole("button", { name: "Rejoin", exact: true }).click();
    await bannerHas(B, "Pick your secret number", 9000);
    await bannerHas(A, "Waiting for Ben to pick their number", 9000);
    await pick(B, "5678");
    await bannerHas(A, "Your turn", 9000);

    // ---- End round with confirmation, then End game with confirmation ----
    await openControls(A);
    await A.getByRole("button", { name: "End round" }).click();
    await A.getByText("End this round with no winner? Both numbers will be revealed, and nobody scores.").waitFor();
    await shot(A, `s9-${tag}-endround-confirm`);
    await A.getByRole("button", { name: "Yes, end round" }).click();
    await bannerHas(A, "The round ended with no winner", 9000);
    await bannerHas(B, "The round ended with no winner", 9000);
    check((await revealed(B)) === "1234,5678", `${tag}: End round reveals both numbers`);
    await openControls(B);
    await B.getByRole("button", { name: "End game", exact: true }).click();
    await B.getByText("End the game for everyone? No more rounds can be played.").waitFor();
    await B.getByRole("button", { name: "Yes, end game" }).click();
    await waitText(B, "Game over", 9000);
    await waitText(A, "Game over", 9000);
    await A.locator(".award").first().waitFor({ timeout: 9000 });
    await sleep(300);
    const names = await A.locator(".award-title").allTextContents();
    log(`  (info) ${tag}: duel awards: ${names.join(" / ")}`);
    check(names.includes("Most wins") && names.includes("Most guesses made") && !names.includes("Most rounds hosted"), `${tag}: duel awards (no hosting award)`);
    await shot(A, `s9-${tag}-gameover`);
    await shot(B, `s9-${tag}-gameover-b`);
    await tapAll(A, `${tag} duel Game over`);
    if (vp === "phone") {
      const box = await A.locator(".gameover-card").boundingBox();
      check(box.y + box.height <= VIEWPORTS.phone.viewport.height - 54, `${tag}: duel Game over fits one phone screen (ends at ${Math.round(box.y + box.height)})`);
    }
    check((await api("pick", { code, secret: "1234" }, { id: "x", token: "y" })).status === 401, `${tag}: (sanity) no token, no pick`);
    await a.ctx.close(); await b.ctx.close();
  }
}

async function openControls(page) {
  const btn = page.getByRole("button", { name: /Duel controls/ });
  await btn.scrollIntoViewIfNeeded();
  if ((await btn.getAttribute("aria-expanded")) !== "true") await btn.click();
}

// The state as this page's player sees it (same request the app makes).
async function getStateFor(page, code) {
  return page.evaluate(async (c) => {
    const cred = JSON.parse(localStorage.getItem(`sd:${c}`));
    const r = await fetch(`/api/state?code=${c}`, { headers: { "x-player-id": cred.id, "x-player-token": cred.token }, cache: "no-store" });
    return r.json();
  }, code);
}
