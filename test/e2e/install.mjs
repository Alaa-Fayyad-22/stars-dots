// Home-screen install checks: manifest, icons, installability, the install hint, and the app running
// full-screen ("standalone") with a notch and home indicator. Standalone: node test/e2e/install.mjs
// Needs the same setup as the other browser tests (see lib.mjs), plus `sharp` (installed by Next.js).
//   SHOTS=e2e-shots/install node test/e2e/install.mjs [phone,tablet,laptop]
import fs from "node:fs";
import sharp from "sharp";
import { chromium } from "playwright";
import { BASE, VIEWPORTS, api, makeGame, pickAs, check, log, sleep, shot, tapCheck, noHorizontalScroll, counts, failures } from "./lib.mjs";

const vps = (process.argv[2] || "phone,tablet,laptop").split(",");
const NOTCH = { top: 47, bottom: 34, left: 0, right: 0 };
const NONE = { top: 0, bottom: 0, left: 0, right: 0 };
const UA_IOS_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const UA_IOS_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.88 Mobile/15E148 Safari/604.1";

// ---------------------------------------------------------------- static checks
async function staticChecks() {
  log("\n[Manifest and icons]");
  const res = await fetch(`${BASE}/manifest.webmanifest`);
  check(res.ok && /manifest\+json|json/.test(res.headers.get("content-type") || ""), "manifest is served as JSON");
  const m = await res.json();
  const want = { name: "Stars & Dots", short_name: "Stars & Dots", start_url: "/", scope: "/", display: "standalone", background_color: "#eaf0ec", theme_color: "#eaf0ec" };
  for (const [k, v] of Object.entries(want)) check(m[k] === v, `manifest.${k} = ${JSON.stringify(v)} (got ${JSON.stringify(m[k])})`);
  check(m.orientation === undefined, "manifest does not lock the orientation");
  check(Array.isArray(m.icons) && m.icons.length === 3, "manifest lists 3 icons");

  const html = await (await fetch(`${BASE}/`)).text();
  check(/<link rel="manifest" href="\/manifest\.webmanifest"/.test(html), "page links the manifest");
  check(/<meta name="theme-color" content="#eaf0ec" media="\(prefers-color-scheme: light\)"/.test(html), "theme-color (light) meta");
  check(/<meta name="theme-color" content="#10160f" media="\(prefers-color-scheme: dark\)"/.test(html), "theme-color (dark) meta");
  check(/apple-mobile-web-app-capable" content="yes"/.test(html), "apple-mobile-web-app-capable");
  check(/apple-mobile-web-app-title" content="Stars &amp; Dots"/.test(html), "apple-mobile-web-app-title");
  check(/apple-mobile-web-app-status-bar-style" content="default"/.test(html), "apple status bar style");
  check(/rel="apple-touch-icon" href="\/apple-touch-icon\.png"/.test(html), "apple-touch-icon link");
  check(/viewport[^>]*viewport-fit=cover/.test(html), "viewport-fit=cover is still set");

  for (const ic of m.icons) {
    const r = await fetch(BASE + ic.src);
    const buf = Buffer.from(await r.arrayBuffer());
    const meta = await sharp(buf).metadata();
    const [w, h] = ic.sizes.split("x").map(Number);
    check(r.ok && meta.format === "png" && meta.width === w && meta.height === h, `${ic.src} is a ${w}x${h} PNG (${ic.purpose})`);
  }
  const apple = Buffer.from(await (await fetch(`${BASE}/apple-touch-icon.png`)).arrayBuffer());
  const am = await sharp(apple).metadata();
  check(am.width === 180 && am.height === 180 && !am.hasAlpha, `apple-touch-icon.png is 180x180 with no transparency (${am.width}x${am.height}, alpha=${am.hasAlpha})`);
  const ico = Buffer.from(await (await fetch(`${BASE}/favicon.ico`)).arrayBuffer());
  check(ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) >= 1, "favicon.ico is a valid ICO");
  check(fs.existsSync("public/icons/icon.svg"), "icon source SVG is in the project");

  // Maskable safe zone: every non-background pixel inside the circle of radius 40% of the width.
  const { data, info } = await sharp("public/icons/icon-maskable-512.png").removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const bg = [0x10, 0x16, 0x0f];
  let far = 0, count = 0, maxD = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * 3;
    if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) < 12) continue;
    count++;
    const d = Math.hypot(x + 0.5 - info.width / 2, y + 0.5 - info.height / 2);
    maxD = Math.max(maxD, d);
    if (d > info.width * 0.4) far++;
  }
  check(count > 5000 && far === 0, `maskable icon: all artwork within the center safe zone (farthest ${maxD.toFixed(0)}px of ${(info.width * 0.4).toFixed(0)}px allowed)`);
  const corner = [data[0], data[1], data[2]];
  check(corner.every((v, i) => v === bg[i]), "maskable icon is full-bleed solid background");

  // Static files carry no cookies / are plain; nothing registers a service worker.
  check(!/serviceWorker\.register/.test(html), "no service worker registration in the page");
  const sw = await fetch(`${BASE}/sw.js`);
  check(sw.status === 404, "there is no /sw.js");
}

// ---------------------------------------------------------------- contexts
async function newCtx(browser, vp, { dark = false, standalone = false, insets = NONE, ua, iosStandalone = false, blockStorage = false } = {}) {
  const ctx = await browser.newContext({
    ...VIEWPORTS[vp],
    ...(ua ? { userAgent: ua } : {}),
    permissions: ["clipboard-read", "clipboard-write"],
    colorScheme: dark ? "dark" : "light",
  });
  // Pretend to be the installed app.
  if (standalone || iosStandalone) {
    await ctx.addInitScript(([s, i]) => {
      if (s) {
        const real = window.matchMedia.bind(window);
        window.matchMedia = (q) => {
          if (/display-mode:\s*standalone/.test(q)) {
            return { matches: true, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } };
          }
          return real(q);
        };
      }
      if (i) Object.defineProperty(navigator, "standalone", { value: true });
    }, [standalone, iosStandalone]);
  }
  if (blockStorage) {
    await ctx.addInitScript(() => {
      const boom = () => { throw new Error("storage blocked"); };
      Storage.prototype.getItem = boom; Storage.prototype.setItem = boom; Storage.prototype.removeItem = boom;
    });
  }
  // Emulate a notch / home indicator: the CSS asks the browser for env(safe-area-inset-*), which
  // headless Chromium always reports as 0, so swap in fixed numbers before the CSS is applied.
  if (insets !== NONE) {
    await ctx.route(/\.css(\?|$)/, async (route) => {
      const res = await route.fetch();
      const body = (await res.text()).replace(/env\(\s*safe-area-inset-(top|bottom|left|right)\s*(?:,\s*0px\s*)?\)/g, (_, side) => `${insets[side]}px`);
      await route.fulfill({ response: res, body, headers: { ...res.headers(), "content-length": undefined } });
    });
  }
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 200)));
  return { ctx, page };
}

async function seed(page, game, player) {
  await page.addInitScript(([code, id, token]) => {
    try { localStorage.setItem(`sd:${code}`, JSON.stringify({ id, token })); } catch {}
  }, [game.code, player.id, player.token]);
}

const fireInstallEvent = (page) => page.evaluate(() => {
  const e = new Event("beforeinstallprompt", { cancelable: true });
  e.prompt = async () => { window.__prompted = true; };
  e.userChoice = Promise.resolve({ outcome: "accepted" });
  window.dispatchEvent(e);
});
const hint = (page) => page.locator(".install-hint");
async function loadHome(page) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.locator("h1").first().waitFor();
  await sleep(300);
}

// ---------------------------------------------------------------- install hint
async function hintChecks(browser) {
  log("\n[Install hint]");
  // Desktop / Android style: only when the browser offers it.
  let { ctx, page } = await newCtx(browser, "laptop");
  await loadHome(page);
  check((await hint(page).count()) === 0, "normal desktop browser, no install offer: no hint");
  await fireInstallEvent(page);
  await hint(page).waitFor({ timeout: 3000 });
  check(await page.getByRole("button", { name: "Install app" }).isVisible(), "install offer: 'Install app' button is shown");
  await shot(page, "hint-desktop-light");
  await page.getByRole("button", { name: "Install app" }).click();
  await sleep(300);
  check(await page.evaluate(() => window.__prompted === true), "'Install app' calls the browser's install prompt");
  check((await hint(page).count()) === 0, "hint goes away after the app is installed");
  await ctx.close();

  // Dismiss is remembered; the offer coming again does not bring it back.
  ({ ctx, page } = await newCtx(browser, "phone", { dark: true }));
  await loadHome(page);
  await fireInstallEvent(page);
  await hint(page).waitFor({ timeout: 3000 });
  await shot(page, "hint-phone-dark");
  check((await page.getByRole("button", { name: "Dismiss install hint" }).boundingBox()).width >= 43.5, "dismiss button is at least 44px wide");
  await page.getByRole("button", { name: "Dismiss install hint" }).click();
  check((await hint(page).count()) === 0, "dismissing hides the hint");
  await page.reload({ waitUntil: "networkidle" });
  await fireInstallEvent(page);
  await sleep(400);
  check((await hint(page).count()) === 0, "after dismissing, the hint stays gone on this device");
  check(await page.evaluate(() => localStorage.getItem("sd:install-hint-dismissed") === "1"), "dismissal is remembered in localStorage");
  await ctx.close();

  // iPhone Safari.
  ({ ctx, page } = await newCtx(browser, "phone", { ua: UA_IOS_SAFARI }));
  await loadHome(page);
  await hint(page).waitFor({ timeout: 3000 });
  const t = (await hint(page).innerText()).replace(/\s+/g, " ").replace("✕", "").trim();
  check(t === "Add Stars & Dots to your home screen: tap Share, then Add to Home Screen.", `iPhone Safari text is exact ("${t}")`);
  await shot(page, "hint-iphone-light");
  await page.getByRole("button", { name: "Dismiss install hint" }).click();
  await page.reload({ waitUntil: "networkidle" });
  await sleep(300);
  check((await hint(page).count()) === 0, "iPhone: dismissed hint stays gone");
  await ctx.close();

  // iPhone Chrome / other iOS browsers: no Safari instructions.
  ({ ctx, page } = await newCtx(browser, "phone", { ua: UA_IOS_CHROME }));
  await loadHome(page);
  check((await hint(page).count()) === 0, "iPhone in Chrome (not Safari): no hint");
  await ctx.close();

  // Installed app: never.
  ({ ctx, page } = await newCtx(browser, "phone", { standalone: true }));
  await loadHome(page);
  await fireInstallEvent(page);
  await sleep(400);
  check((await hint(page).count()) === 0, "display-mode: standalone: no hint even if the browser offers install");
  await ctx.close();
  ({ ctx, page } = await newCtx(browser, "phone", { ua: UA_IOS_SAFARI, iosStandalone: true }));
  await loadHome(page);
  await sleep(400);
  check((await hint(page).count()) === 0, "iPhone home-screen app (navigator.standalone): no hint");
  await ctx.close();

  // localStorage unavailable: no crash.
  ({ ctx, page } = await newCtx(browser, "phone", { ua: UA_IOS_SAFARI, blockStorage: true }));
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await loadHome(page);
  await hint(page).waitFor({ timeout: 3000 });
  await page.getByRole("button", { name: "Dismiss install hint" }).click();
  check(errs.length === 0 && (await hint(page).count()) === 0, `blocked localStorage: hint still works, no errors (${errs.join("; ")})`);
  await ctx.close();

  // Never during a game; but an offer that arrived during a game is kept for the home page.
  const game = await makeGame({ mode: "rotating", count: 3 });
  await pickAs(game, game.players[0], "4715");
  ({ ctx, page } = await newCtx(browser, "laptop"));
  await seed(page, game, game.players[1]);
  await page.goto(`${BASE}/game/${game.code}`, { waitUntil: "networkidle" });
  await page.locator("#g").waitFor({ timeout: 9000 });
  await fireInstallEvent(page);
  await sleep(400);
  check((await hint(page).count()) === 0, "no install hint on the game page");
  await page.getByRole("button", { name: "New game" }).click();
  await page.locator("h1", { hasText: "Stars & Dots" }).waitFor();
  await hint(page).waitFor({ timeout: 3000 });
  check(true, "an install offer that arrived during a game shows on the home page afterwards");
  await ctx.close();
}

// ---------------------------------------------------------------- safe areas
// Anything you can read or tap must sit clear of the notch/status area (checked at the top of the
// page) and the home indicator (checked at the bottom), inside `root`.
async function safeAreas(page, label, insets, { root = "body", top = true, bottom = true } = {}) {
  const r = await page.evaluate(([sel, ins, doTop, doBottom]) => {
    const rootEl = document.querySelector(sel);
    if (!rootEl) return { missing: true, bad: [] };
    const vh = window.innerHeight;
    const bad = [];
    const d = (e) => `${e.tagName.toLowerCase()}${e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/)[0] : ""} "${(e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 22)}"`;
    for (const el of rootEl.querySelectorAll("button, a[href], input, select, h1, h2, h3, label, .room-code")) {
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height || b.bottom <= 0 || b.top >= vh) continue;
      if (doTop && b.top < ins.top - 0.5) bad.push(`${d(el)} reaches into the top ${ins.top}px (top=${Math.round(b.top)})`);
      if (doBottom && b.bottom > vh - ins.bottom + 0.5) bad.push(`${d(el)} reaches into the bottom ${ins.bottom}px (bottom=${Math.round(b.bottom)} of ${vh})`);
    }
    return { bad };
  }, [root, insets, top, bottom]);
  check(!r.missing, `${label}: ${root} is present`);
  check(r.bad.length === 0, `${label}: clear of notch and home indicator ${r.bad.slice(0, 3).join("; ")}`);
}

async function atTop(page) { await page.evaluate(() => window.scrollTo(0, 0)); await sleep(250); }
async function atBottom(page) { await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await sleep(350); }

// A visible link or button that goes back to the home page.
async function hasWayHome(page, label) {
  const n = await page.locator('a[href="/"]:visible').count();
  check(n > 0, `${label}: a visible way back to the home page`);
}

async function standaloneChecks(browser, vp) {
  const phone = vp === "phone";
  for (const dark of [false, true]) {
    const tag = `${vp}${dark ? "-dark" : "-light"}`;
    const insets = phone ? NOTCH : NONE;
    log(`\n[Standalone ${tag}]`);
    const game = await makeGame({ mode: "rotating", digits: 4, count: 4 });
    const [A, B, C, D] = game.players;
    await pickAs(game, A, "4715");
    await api("guess", { code: game.code, guess: "1234" }, B);

    // Home page (+ the safe area really applied).
    let { ctx, page } = await newCtx(browser, vp, { dark, standalone: true, insets });
    await loadHome(page);
    const pad = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".shell")).paddingTop));
    check(Math.abs(pad - (24 + insets.top)) < 1, `${tag} home: page starts below the top inset (padding ${pad}px)`);
    check((await hint(page).count()) === 0, `${tag} home: no install hint in the installed app`);
    check(await noHorizontalScroll(page), `${tag} home: no sideways scroll`);
    await atTop(page); await safeAreas(page, `${tag} home top`, insets, { bottom: false });
    await atBottom(page); await safeAreas(page, `${tag} home bottom`, insets, { top: false });
    await atTop(page);
    let r = await tapCheck(page);
    check(r.covered.length === 0, `${tag} home: nothing covered ${r.covered.join("; ")}`);
    await shot(page, `standalone-${tag}-home`);
    // join / rejoin screens on the home page
    await page.locator("#jc").fill(game.code);
    await page.getByRole("button", { name: "Already in this game?" }).click();
    await page.locator(".rejoin-panel").waitFor();
    await page.locator("#rn").waitFor({ timeout: 5000 });
    check(await page.getByRole("button", { name: "Join as a new player instead" }).isVisible(), `${tag} home rejoin panel: has a way back ("Join as a new player instead")`);
    await shot(page, `standalone-${tag}-home-rejoin`);
    await page.getByRole("button", { name: "Join as a new player instead" }).click();
    check(await page.locator("#jn").isVisible(), `${tag} home: back from rejoin to the join form works`);
    await ctx.close();

    // A game in progress, scratch sheet, chat, summary.
    ({ ctx, page } = await newCtx(browser, vp, { dark, standalone: true, insets }));
    await seed(page, game, C);
    await page.goto(`${BASE}/game/${game.code}`, { waitUntil: "networkidle" });
    await page.locator("#g").waitFor({ timeout: 9000 });
    check((await hint(page).count()) === 0, `${tag} game: no install hint`);
    await hasWayHome(page, `${tag} game`);
    await atTop(page); await safeAreas(page, `${tag} game top`, insets, { bottom: false });
    await atBottom(page); await safeAreas(page, `${tag} game bottom`, insets, { top: false });
    await atTop(page);
    r = await tapCheck(page);
    check(r.covered.length === 0, `${tag} game: nothing covered ${r.covered.join("; ")}`);
    check(await noHorizontalScroll(page), `${tag} game: no sideways scroll`);
    await shot(page, `standalone-${tag}-game`);

    // Copy code + Invite still work.
    await page.getByRole("button", { name: "Copy game code" }).click();
    check(await page.getByRole("button", { name: "Game code copied" }).isVisible(), `${tag} game: Copy code works`);
    check((await page.evaluate(() => navigator.clipboard.readText())) === game.code, `${tag} game: the code is on the clipboard`);
    await page.evaluate(() => { window.__shared = null; navigator.share = async (d) => { window.__shared = d; }; });
    await page.getByRole("button", { name: "Invite" }).click();
    await sleep(200);
    const shared = await page.evaluate(() => window.__shared);
    check(shared && shared.url === `${BASE}/game/${game.code}`, `${tag} game: Invite uses navigator.share with the game link`);

    // Scratch sheet
    await page.getByRole("button", { name: "Scratch sheet" }).first().click();
    await page.locator("dialog.sheet[open]").waitFor();
    await sleep(300);
    await safeAreas(page, `${tag} scratch sheet`, insets, { root: "dialog.sheet[open]" });
    r = await tapCheck(page, { root: "dialog.sheet[open]" });
    check(r.covered.length === 0, `${tag} scratch sheet: nothing covered ${r.covered.join("; ")}`);
    const close = page.locator("dialog.sheet[open] .sheet-close");
    check(await close.isVisible(), `${tag} scratch sheet: close button visible`);
    await shot(page, `standalone-${tag}-scratch`);
    await close.click();
    check((await page.locator("dialog.sheet[open]").count()) === 0, `${tag} scratch sheet: close button closes it`);

    // Chat: phone = bar + sheet; wider = the chat section on the page.
    if (phone) {
      await page.locator(".chat-dock-btn").click();
      await page.locator("dialog.chat-sheet[open]").waitFor();
      await sleep(400);
      await safeAreas(page, `${tag} chat sheet`, insets, { root: "dialog.chat-sheet[open]" });
      r = await tapCheck(page, { root: "dialog.chat-sheet[open]" });
      check(r.covered.length === 0, `${tag} chat sheet: nothing covered ${r.covered.join("; ")}`);
      await shot(page, `standalone-${tag}-chat`);
      await page.locator("dialog.chat-sheet[open] .chat-sheet-close").click();
      check((await page.locator("dialog.chat-sheet[open]").count()) === 0, `${tag} chat sheet: close button closes it`);
      // the phone chat bar sits above the home indicator
      await atBottom(page);
      const dock = await page.locator(".chat-dock-btn").boundingBox();
      check(dock && dock.y + dock.height <= 844 - insets.bottom + 0.5, `${tag} phone chat bar: above the home indicator`);
      await shot(page, `standalone-${tag}-chatbar`);
    } else {
      await atTop(page);
      await shot(page, `standalone-${tag}-chat-wide`);
    }

    // Summary dialog
    await atTop(page);
    const sum = page.getByRole("button", { name: "Summary so far" }).first();
    if (await sum.count()) {
      await sum.scrollIntoViewIfNeeded();
      await sum.click();
      await page.locator("dialog.modal[open]").waitFor();
      await sleep(300);
      await safeAreas(page, `${tag} summary dialog`, insets, { root: "dialog.modal[open]" });
      check(await page.locator("dialog.modal[open] .modal-close").isVisible(), `${tag} summary dialog: close button visible`);
      await shot(page, `standalone-${tag}-summary`);
      await page.locator("dialog.modal[open] .modal-close").click();
      check((await page.locator("dialog.modal[open]").count()) === 0, `${tag} summary dialog: close button closes it`);
    }
    await ctx.close();

    // Join screen (not in the game yet)
    ({ ctx, page } = await newCtx(browser, vp, { dark, standalone: true, insets }));
    await page.goto(`${BASE}/game/${game.code}`, { waitUntil: "networkidle" });
    await page.locator("#n").waitFor({ timeout: 9000 });
    await hasWayHome(page, `${tag} join screen`);
    await atTop(page); await safeAreas(page, `${tag} join top`, insets, { bottom: false });
    await atBottom(page); await safeAreas(page, `${tag} join bottom`, insets, { top: false });
    await shot(page, `standalone-${tag}-join`);
    await page.getByRole("tab", { name: "Already in this game?" }).click();
    check(await page.getByRole("tab", { name: "New player" }).isVisible(), `${tag} join screen: can switch back from the rejoin tab`);
    await ctx.close();

    // Game not found
    ({ ctx, page } = await newCtx(browser, vp, { dark, standalone: true, insets }));
    await page.goto(`${BASE}/game/ZZZZZ`);
    await page.getByText("Game not found").waitFor({ timeout: 9000 });
    await hasWayHome(page, `${tag} game not found`);
    await atTop(page); await safeAreas(page, `${tag} not found`, insets);
    await shot(page, `standalone-${tag}-notfound`);
    await ctx.close();

    // Left the game
    await api("leave", { code: game.code }, D);
    ({ ctx, page } = await newCtx(browser, vp, { dark, standalone: true, insets }));
    await seed(page, game, D);
    await page.goto(`${BASE}/game/${game.code}`, { waitUntil: "networkidle" });
    await page.getByText("You left the game").waitFor({ timeout: 9000 });
    await hasWayHome(page, `${tag} left screen`);
    check(await page.getByRole("button", { name: "Rejoin" }).isVisible(), `${tag} left screen: Rejoin button`);
    await atTop(page); await safeAreas(page, `${tag} left top`, insets, { bottom: false });
    await atBottom(page); await safeAreas(page, `${tag} left bottom`, insets, { top: false });
    await shot(page, `standalone-${tag}-left`);
    await ctx.close();

    // Removed by the host
    await api("remove", { code: game.code, targetPlayerId: C.id }, A);
    ({ ctx, page } = await newCtx(browser, vp, { dark, standalone: true, insets }));
    await seed(page, game, C);
    await page.goto(`${BASE}/game/${game.code}`, { waitUntil: "networkidle" });
    await page.getByText("You've been removed").waitFor({ timeout: 9000 });
    await hasWayHome(page, `${tag} removed screen`);
    await shot(page, `standalone-${tag}-removed`);
    await ctx.close();

    // Game over
    const end = await makeGame({ mode: "rotating", digits: 4, count: 3 });
    await pickAs(end, end.players[0], "4715");
    await api("guess", { code: end.code, guess: "1234" }, end.players[1]);
    await api("endgame", { code: end.code }, end.players[0]);
    ({ ctx, page } = await newCtx(browser, vp, { dark, standalone: true, insets }));
    await seed(page, end, end.players[1]);
    await page.goto(`${BASE}/game/${end.code}`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Game over" }).waitFor({ timeout: 9000 });
    await sleep(500);
    check(await page.getByRole("link", { name: "Start a new game" }).isVisible(), `${tag} game over: "Start a new game" is visible`);
    await hasWayHome(page, `${tag} game over`);
    await atTop(page); await safeAreas(page, `${tag} game over top`, insets, { bottom: false });
    await atBottom(page); await safeAreas(page, `${tag} game over bottom`, insets, { top: false });
    await atTop(page);
    r = await tapCheck(page);
    check(r.covered.length === 0, `${tag} game over: nothing covered ${r.covered.join("; ")}`);
    check(await noHorizontalScroll(page), `${tag} game over: no sideways scroll`);
    await shot(page, `standalone-${tag}-gameover`);
    if (phone) {
      // the phone chat bar on this screen as well
      await atBottom(page);
      const dock = await page.locator(".chat-dock-btn").boundingBox();
      check(dock && dock.y + dock.height <= 844 - insets.bottom + 0.5, `${tag} game over: chat bar above the home indicator`);
    }
    await page.getByRole("link", { name: "Start a new game" }).click();
    await page.locator("h1", { hasText: "Stars & Dots" }).waitFor();
    check(page.url() === `${BASE}/`, `${tag} game over: "Start a new game" goes home`);
    await ctx.close();
  }
}

// ---------------------------------------------------------------- run
const browser = await chromium.launch({ args: ["--disable-features=Translate"] });
try {
  await staticChecks();
  // Chrome's own installability test (what decides whether it offers "Install").
  const { ctx, page } = await newCtx(browser, "laptop");
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const cdp = await ctx.newCDPSession(page);
  const inst = await cdp.send("Page.getInstallabilityErrors");
  check(inst.installabilityErrors.length === 0, `Chrome installability errors: ${JSON.stringify(inst.installabilityErrors)}`);
  const man = await cdp.send("Page.getAppManifest");
  check(!man.errors || man.errors.length === 0, `Chrome manifest parse errors: ${JSON.stringify(man.errors)}`);
  const regs = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
  check(regs === 0, "no service worker is registered");
  await ctx.close();

  await hintChecks(browser);
  for (const vp of vps) await standaloneChecks(browser, vp);
} catch (e) {
  failures.push(`crashed: ${e.stack.split("\n").slice(0, 4).join(" | ")}`);
  console.log("CRASH", e.stack);
}
await browser.close();
const c = counts();
log(`\nINSTALL: ${c.passed} passed, ${c.failed} failed`);
if (c.failed) { log(failures.map((f) => "- " + f).join("\n")); process.exit(1); }
