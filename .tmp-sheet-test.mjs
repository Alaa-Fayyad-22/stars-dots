import { chromium, webkit, devices } from "playwright";

const BASE = "http://localhost:3000";

async function setupGame(guessCount = 22) {
  const host = await (await fetch(`${BASE}/api/create`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Sam", secret: "1234" }),
  })).json();
  const code = host.code;
  const p = await (await fetch(`${BASE}/api/join`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, name: "Tester" }),
  })).json();

  function randGuess(seedOffset) {
    const digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
    const arr = [...digits];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = (i * 7 + seedOffset * 13) % (i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, 4).join("");
  }
  const seen = new Set();
  const guesses = [];
  let n = 0;
  while (guesses.length < guessCount && n < 400) {
    const g = randGuess(n++);
    if (/^[1-9]\d{3}$/.test(g) && new Set(g).size === 4 && !seen.has(g) && g !== "1234") {
      seen.add(g);
      guesses.push(g);
    }
  }
  for (const g of guesses) {
    await fetch(`${BASE}/api/guess`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, playerId: p.playerId, guess: g }),
    });
  }
  return { code, playerId: p.playerId, guessCount: guesses.length };
}

async function testOnPage(page, label) {
  const results = { label, pass: [], fail: [] };
  function check(desc, cond) {
    if (cond) results.pass.push(desc);
    else results.fail.push(desc);
  }

  const viewport = page.viewportSize();

  // Record initial scroll position and scroll the page down a bit first,
  // so we can verify the lock/restore doesn't just coincidentally work at 0.
  await page.evaluate(() => window.scrollTo(0, 150));
  await page.waitForTimeout(150);
  const scrollBefore = await page.evaluate(() => window.scrollY);
  check("page scrolled to 150 before opening sheet", scrollBefore > 100);

  // Open the sheet
  await page.getByRole("button", { name: "Scratch sheet" }).click();
  await page.waitForTimeout(300);

  const dialogVisible = await page.locator("dialog.sheet[open]").isVisible();
  check("dialog is open and visible", dialogVisible);

  // Check the pinned bottom section (Clear draft) is fully within the viewport
  const clearDraftBox = await page.locator(".sheet-draft .draft-clear").boundingBox();
  check("Clear draft button found", !!clearDraftBox);
  if (clearDraftBox && viewport) {
    const bottomEdge = clearDraftBox.y + clearDraftBox.height;
    check(
      `Clear draft fully visible (bottom edge ${bottomEdge.toFixed(1)} <= viewport height ${viewport.height})`,
      bottomEdge <= viewport.height + 1
    );
    check("Clear draft top edge within viewport", clearDraftBox.y >= 0);
  }

  // Screenshot with sheet open
  await page.screenshot({ path: `.tmp-screenshots/${label}-sheet-open.png` });

  // Try scrolling the background page (simulate a touch/wheel outside the sheet
  // list area isn't trivial via wheel on backdrop since dialog covers it, but
  // we can directly assert the background didn't move via window.scrollY,
  // and separately scroll the sheet's own list).
  const scrollDuringOpen = await page.evaluate(() => window.scrollY);
  check("background scrollY unchanged immediately after opening", scrollDuringOpen === 0 || scrollDuringOpen === scrollBefore);

  // Scroll the sheet's guess list and confirm the background stays put
  const list = page.locator(".sheet-list");
  await list.evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(100);
  const listScrollTopBefore = await list.evaluate((el) => el.scrollTop);
  await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(150);
  const listScrollTopAfter = await list.evaluate((el) => el.scrollTop);
  check("sheet list actually scrolled", listScrollTopAfter > listScrollTopBefore);

  const bodyScrollYWhileScrollingList = await page.evaluate(() => window.scrollY);
  check("background window.scrollY still 0 while sheet list scrolled", bodyScrollYWhileScrollingList === 0);

  const bodyPosition = await page.evaluate(() => getComputedStyle(document.body).position);
  check("body is position:fixed while sheet open", bodyPosition === "fixed");

  // Count visible guess rows without scrolling (row count that fit before we scrolled)
  const rowCount = await page.locator(".sheet-row").count();
  check(`sheet has ${rowCount} guess rows in DOM (>= 20 expected)`, rowCount >= 20);

  // Close the sheet via the close button
  await page.locator(".sheet-close").click();
  await page.waitForTimeout(300);

  const dialogOpenAfterClose = await page.locator("dialog.sheet").evaluate((el) => el.open);
  check("dialog closed after clicking close button", dialogOpenAfterClose === false);

  const bodyPositionAfterClose = await page.evaluate(() => getComputedStyle(document.body).position);
  check("body position restored (not fixed) after close", bodyPositionAfterClose !== "fixed");

  const scrollAfterClose = await page.evaluate(() => window.scrollY);
  check(
    `page scroll restored after close (before=${scrollBefore}, after=${scrollAfterClose})`,
    Math.abs(scrollAfterClose - scrollBefore) <= 2
  );

  // Verify the page scrolls normally again
  await page.evaluate(() => window.scrollTo(0, 300));
  await page.waitForTimeout(100);
  const scrollAfterManualScroll = await page.evaluate(() => window.scrollY);
  check("page scrolls normally after sheet closed", Math.abs(scrollAfterManualScroll - 300) <= 2);

  // Reopen and test Escape closes it + restores scroll again
  await page.evaluate(() => window.scrollTo(0, 400));
  await page.waitForTimeout(100);
  const scrollBefore2 = await page.evaluate(() => window.scrollY);
  await page.getByRole("button", { name: "Scratch sheet" }).click();
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const dialogOpenAfterEscape = await page.locator("dialog.sheet").evaluate((el) => el.open);
  check("dialog closed after Escape", dialogOpenAfterEscape === false);
  const scrollAfterEscape = await page.evaluate(() => window.scrollY);
  check(
    `scroll restored after Escape close (before=${scrollBefore2}, after=${scrollAfterEscape})`,
    Math.abs(scrollAfterEscape - scrollBefore2) <= 2
  );
  const bodyPositionAfterEscape = await page.evaluate(() => getComputedStyle(document.body).position);
  check("body position restored after Escape close", bodyPositionAfterEscape !== "fixed");

  return results;
}

async function main() {
  const fs = await import("fs");
  fs.mkdirSync(".tmp-screenshots", { recursive: true });

  const { code, playerId, guessCount } = await setupGame(22);
  console.log(`Game ${code} set up with ${guessCount} guesses, playerId ${playerId}`);

  const allResults = [];

  // --- WebKit + iPhone 14 emulation ---
  {
    const browser = await webkit.launch();
    const context = await browser.newContext({ ...devices["iPhone 14"] });
    const page = await context.newPage();
    await page.goto(`${BASE}/game/${code}`);
    await page.evaluate((pid) => localStorage.setItem(`sd:${location.pathname.split("/").pop()}`, pid), playerId);
    await page.reload();
    await page.waitForTimeout(500);
    allResults.push(await testOnPage(page, "webkit-iphone14"));
    await browser.close();
  }

  // --- Chromium at 390px width ---
  {
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(`${BASE}/game/${code}`);
    await page.evaluate((pid) => localStorage.setItem(`sd:${location.pathname.split("/").pop()}`, pid), playerId);
    await page.reload();
    await page.waitForTimeout(500);
    allResults.push(await testOnPage(page, "chromium-390"));
    await browser.close();
  }

  console.log("\n===== RESULTS =====");
  let totalFail = 0;
  for (const r of allResults) {
    console.log(`\n-- ${r.label} --`);
    for (const p of r.pass) console.log(`  ok - ${p}`);
    for (const f of r.fail) { console.log(`  FAIL - ${f}`); totalFail++; }
  }
  console.log(`\n${totalFail === 0 ? "ALL PASSED" : `${totalFail} FAILURES`}`);
  process.exit(totalFail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
