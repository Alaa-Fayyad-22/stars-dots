// Browser tests (Playwright). Not a project dependency — install it outside the repo or with
//   npm i --no-save playwright
// then, with the app running against the fake database:
//   node test/serve-fake-upstash.js 8791
//   UPSTASH_REDIS_REST_URL=http://127.0.0.1:8791 UPSTASH_REDIS_REST_TOKEN=x npx next start -p 3100
//   node test/e2e/run.mjs            (all)   |   node test/e2e/run.mjs s3-picker phone,laptop
// Screenshots land in ./e2e-shots (or $SHOTS).
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

export const BASE = process.env.BASE || "http://127.0.0.1:3100";
export const SHOTS = process.env.SHOTS || "e2e-shots";
fs.mkdirSync(SHOTS, { recursive: true });

export const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  tablet: { viewport: { width: 820, height: 1180 }, isMobile: false, hasTouch: true, deviceScaleFactor: 1 },
  laptop: { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
};

let passed = 0;
export const failures = [];
export function check(cond, msg) {
  if (cond) { passed++; return true; }
  failures.push(msg);
  console.log("  FAIL -", msg);
  return false;
}
export const counts = () => ({ passed, failed: failures.length });
export const log = (...a) => console.log(...a);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- API helpers (set-up and "other players" who don't need a browser) ----
export async function api(route, body, who) {
  const headers = { "Content-Type": "application/json" };
  if (who) { headers["x-player-id"] = who.id; headers["x-player-token"] = who.token; }
  const res = await fetch(`${BASE}/api/${route}`, { method: "POST", headers, body: JSON.stringify(body || {}) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}
export async function getState(code, who) {
  const headers = {};
  if (who) { headers["x-player-id"] = who.id; headers["x-player-token"] = who.token; }
  const res = await fetch(`${BASE}/api/state?code=${code}`, { headers, cache: "no-store" });
  return res.json();
}

const NAMES = ["Ana", "Boro", "Cleo", "Dax", "Eli", "Fen"];
export async function makeGame({ mode = "rotating", digits = 4, count = 3, hostName = "Hosty" } = {}) {
  const names = [hostName, ...NAMES.filter((n) => n !== hostName)].slice(0, count);
  const first = await api("create", { name: names[0], pin: "1111", mode, digits });
  const players = [{ name: names[0], id: first.playerId, token: first.token, pin: "1111" }];
  for (let i = 1; i < count; i++) {
    const j = await api("join", { code: first.code, name: names[i], pin: "1111" });
    players.push({ name: names[i], id: j.playerId, token: j.token, pin: "1111" });
  }
  return { code: first.code, players, mode, digits };
}

// The number for the current round — read from the host's own state. (Only
// the rotating host can ever see it; in computer mode tests never need it.)
export async function pickAs(game, host, secret) {
  const r = await api("pick", { code: game.code, secret }, host);
  if (r.error) throw new Error("pick: " + r.error);
}

let guessSeed = 0;
export function nextGuess(digits, used) {
  for (let i = 0; i < 5000; i++) {
    guessSeed = (guessSeed * 7919 + 104729 + i) % 1000003;
    const pool = "0123456789".split("");
    let s = "";
    let x = guessSeed + i * 31;
    while (s.length < digits) { const k = x % pool.length; s += pool.splice(k, 1)[0]; x = Math.floor(x / 3) + 17 + i; }
    if (s[0] !== "0" && !used.has(s)) return s;
  }
  throw new Error("no guess");
}

// A wrong guess by whoever's turn it is (API only).
export async function wrongGuess(game, viewer) {
  const s = await getState(game.code, viewer);
  const used = new Set(s.players.flatMap((p) => p.history.map((h) => h.guess)));
  const cur = game.players.find((p) => p.id === s.currentPlayerId);
  const r = await api("guess", { code: game.code, guess: nextGuess(game.digits, used) }, cur);
  if (r.error) throw new Error("guess: " + r.error);
  return cur;
}

// ---- browser helpers ----
export async function launch() {
  return chromium.launch({ args: ["--disable-features=Translate"] });
}

export async function openAs(browser, game, player, vpName, extra = {}) {
  const ctx = await browser.newContext({
    ...VIEWPORTS[vpName],
    permissions: ["clipboard-read", "clipboard-write"],
    reducedMotion: extra.reducedMotion ? "reduce" : "no-preference",
    colorScheme: extra.dark ? "dark" : "light",
  });
  if (player) {
    await ctx.addInitScript(([code, id, token]) => {
      try { localStorage.setItem(`sd:${code}`, JSON.stringify({ id, token })); } catch {}
    }, [game.code, player.id, player.token]);
  }
  if (extra.fakeAudio) {
    await ctx.addInitScript(() => {
      window.__audio = { gains: [] };
      class FakeAC {
        constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
        resume() {}
        createOscillator() { return { frequency: { value: 0 }, type: "", connect() {}, start() {}, stop() {} }; }
        createGain() {
          const calls = [];
          window.__audio.gains.push(calls);
          return { gain: { setValueAtTime(v) { calls.push(v); }, exponentialRampToValueAtTime(v) { calls.push(v); } }, connect() {} };
        }
        createBufferSource() { return { connect() {}, start() {} }; }
        decodeAudioData(d, ok) { ok && ok(null); }
      }
      window.AudioContext = FakeAC;
    });
  }
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { if (!/ResizeObserver/.test(String(e))) console.log("  [pageerror]", String(e).slice(0, 200)); });
  await page.goto(`${BASE}/game/${game.code}`);
  return { ctx, page };
}

export async function shot(page, name) {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

export async function waitText(page, text, timeout = 9000) {
  await page.getByText(text, { exact: false }).first().waitFor({ timeout });
}

// Taps every visible button / input / link / select in the topmost layer and
// reports the ones something else is drawn over. `root` limits it to an open
// dialog. Notifications (chat toasts, the "Your turn!" notice) and an open
// picker count as "allowed" covers, reported separately.
export async function tapCheck(page, { root = "body" } = {}) {
  return page.evaluate((rootSel) => {
    const rootEl = document.querySelector(rootSel) || document.body;
    const els = [...rootEl.querySelectorAll("button, input, select, a[href], textarea")];
    const vw = window.innerWidth, vh = window.innerHeight;
    const out = { checked: 0, covered: [], notifCovered: [], small: [] };
    for (const el of els) {
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || el.disabled && false) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2));
      const cy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
      if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
      // Only test the part that is inside the viewport.
      const vx = Math.min(vw - 1, Math.max(0, (Math.max(r.left, 0) + Math.min(r.right, vw)) / 2));
      const vy = Math.min(vh - 1, Math.max(0, (Math.max(r.top, 0) + Math.min(r.bottom, vh)) / 2));
      out.checked++;
      const top = document.elementFromPoint(vx, vy);
      const desc = (e) => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : ""}`;
      const label = `${desc(el)} "${(el.getAttribute("aria-label") || el.textContent || el.value || "").trim().slice(0, 24)}"`;
      if (top && !(el === top || el.contains(top) || top.contains(el))) {
        const notif = top.closest(".chat-toast, .chat-toasts, .turn-toast, .qs-pop, .chat-newpill, .chat-dock");
        (notif ? out.notifCovered : out.covered).push(`${label} covered by ${desc(top)}`);
      }
      if ((r.height < 43.5 || r.width < 43.5) && el.tagName !== "INPUT" && el.tagName !== "A") out.small.push(`${label} ${Math.round(r.width)}x${Math.round(r.height)}`);
      void cx; void cy;
    }
    return out;
  }, root);
}

export async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 && document.body.scrollWidth <= document.body.clientWidth + 1);
}
