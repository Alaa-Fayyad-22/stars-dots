import { useCallback, useEffect, useState } from "react";

// A person's identity on this device: their public id (for display and for
// choosing targets) and their private token (the only proof of who they are).
// Both live in localStorage. Data saved by an older version held just an id —
// that can't sign anyone in, so it counts as "not signed in" and the person
// rejoins with their name and PIN.
export function savePlayer(code, { id, token }) {
  try { localStorage.setItem(`sd:${code}`, JSON.stringify({ id, token })); } catch {}
}

export function loadPlayer(code) {
  try {
    const parsed = JSON.parse(localStorage.getItem(`sd:${code}`));
    if (parsed && typeof parsed.id === "string" && typeof parsed.token === "string" && parsed.id && parsed.token) {
      return { id: parsed.id, token: parsed.token };
    }
  } catch {}
  return null;
}

export function clearPlayer(code) {
  try { localStorage.removeItem(`sd:${code}`); } catch {}
}

// Who's asking travels in request headers, never in the URL, so it can't end
// up in browser history or server logs.
export function authHeaders(cred) {
  return cred ? { "x-player-id": cred.id, "x-player-token": cred.token } : {};
}

export async function post(url, body, cred) {
  const res = await fetch(url, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...authHeaders(cred) },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: "Something went wrong. Try again." }));
  if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
  return data;
}

export function fetchState(code, cred) {
  return fetch(`/api/state?code=${encodeURIComponent(code)}`, { cache: "no-store", headers: authHeaders(cred) });
}

// Small on-device preferences (never sent anywhere).
export function loadFlag(key, fallback = false) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v === "1"; } catch { return fallback; }
}
export function saveFlag(key, value) {
  try { localStorage.setItem(key, value ? "1" : "0"); } catch {}
}

// Copies text; falls back to a hidden textarea where the clipboard API isn't available.
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

// How a person who isn't playing right now is labeled: "(away)" if they left
// on their own (they can come back), "(removed)" if the host removed them.
export function awayTag(p) {
  if (!p || !p.removed) return "";
  return p.leaveReason === "left" ? " (away)" : " (removed)";
}

// Keeps only digits, drops a digit that's already been typed (no repeats
// allowed), refuses a leading 0, and caps the result at `digits` characters.
export const digitsOnly = (v, digits = 4) => {
  let out = "";
  for (const ch of String(v)) {
    if (!/\d/.test(ch) || out.includes(ch)) continue;
    if (out.length === 0 && ch === "0") continue;
    out += ch;
    if (out.length === digits) break;
  }
  return out;
};

// A number that follows the game's own digit rules: `digits` different
// digits, not starting with 0. Mirrors lib/game.js's isValidSecret for
// client-side UI checks (e.g. enabling "Use as guess") — never imported
// from lib/game.js directly, since that module also pulls in the Redis
// client.
export function isValidNumber(value, digits = 4) {
  if (typeof value !== "string" || value.length !== digits) return false;
  if (!/^[1-9]\d*$/.test(value)) return false;
  return new Set(value).size === digits;
}

// Exactly 4 digits — no other rule (repeats and a leading 0 are both fine).
export function isValidPin(pin) {
  return typeof pin === "string" && /^\d{4}$/.test(pin);
}

export const pinOnly = (v) => String(v).replace(/\D/g, "").slice(0, 4);

export function describePegs(stars, dots) {
  if (stars === 0 && dots === 0) return "no stars or dots";
  return `${"★".repeat(stars)}${"●".repeat(dots)}`;
}

// Client-side mirror of the server's duplicate-guess check, so a warning
// (and disabled button) can show up before the player even submits.
export function findDuplicateGuess(players, guess, playerId) {
  if (!guess) return null;
  for (const p of players) {
    const prior = p.history.find((h) => h.guess === guess);
    if (prior) return { name: p.id === playerId ? "You" : p.name, stars: prior.stars, dots: prior.dots };
  }
  return null;
}

// Whether this player can guess right now — the single source of truth for
// the "Check guess"/DigitEntry enablement, and for the "Your turn" alert
// (vibrate/beep/tab title), which fires exactly when this goes from false to
// true. Mirrors lib/game.js's own turn/host/solved checks for the UI.
export function canPlayerGuess({ roundState, isHostThisRound, solved, currentPlayerId, playerId }) {
  return roundState === "active" && !isHostThisRound && !solved && currentPlayerId === playerId;
}

// Who the turn belongs to, by name, from the same data the screen already
// uses (state.currentPlayerId + state.players). Someone who has left or been
// removed — or an id that isn't in the list — counts as "not found".
export function currentTurnName(players, currentPlayerId) {
  if (!currentPlayerId) return null;
  const p = (players || []).find((x) => x.id === currentPlayerId && !x.removed);
  return p ? p.name : null;
}

// Shown wherever the interface used to say "Not your turn".
export function turnText(players, currentPlayerId) {
  const name = currentTurnName(players, currentPlayerId);
  return name ? `${name}'s turn` : "Waiting for the next player";
}

// The main guess button's label.
export function guessButtonLabel({ canGuess, players, currentPlayerId }) {
  return canGuess ? "Check guess" : turnText(players, currentPlayerId);
}

// The status line at the top of the scratch sheet. `mine` highlights it when
// it's my turn. Live: it's recomputed from the polled state on every render.
export function sheetStatus({ roundState, isHostThisRound, solved, currentPlayerId, playerId, players, hostName }) {
  if (roundState === "pending") {
    if (isHostThisRound) return { text: "Pick the number to start the round", mine: false };
    return { text: `Waiting for ${hostName || "the host"} to pick the number`, mine: false };
  }
  if (roundState === "ended") return { text: "Round over", mine: false };
  if (isHostThisRound) return { text: "You're hosting this round", mine: false };
  if (solved) return { text: "You already found it", mine: false };
  if (currentPlayerId && currentPlayerId === playerId) return { text: "Your turn", mine: true };
  return { text: turnText(players, currentPlayerId), mine: false };
}

// Whether the scratch sheet's "Submit guess" button should be enabled for
// the player's current draft, and — if not — a short, specific reason to
// show near it. Uses the same rules (and duplicate-guess wording) as the
// main guess input, just spelled out with a more granular reason per case.
// Returns `null` when the draft is a submittable guess right now.
export function draftGuessReason({ draft, digits, players, playerId, roundState, isHostThisRound, solved, currentPlayerId }) {
  if (roundState !== "active") return "Round isn't active";
  if (isHostThisRound) return "The host doesn't guess this round";
  if (solved) return "You already found it";
  if (currentPlayerId !== playerId) return turnText(players, currentPlayerId);
  if (!draft.every(Boolean)) return "Fill in all the digits";
  const value = draft.join("");
  if (value[0] === "0") return "Can't start with 0";
  if (new Set(value).size !== digits) return "Repeated digits";
  const dup = findDuplicateGuess(players, value, playerId);
  if (dup) return `${dup.name} already tried this: ${describePegs(dup.stars, dup.dots)}`;
  return null;
}

// --- Private per-player notes (never sent to the server) ---
// Stored per game code + round, so a new round always starts blank and a
// refresh doesn't lose anything.
const emptyNotes = (digits) => ({ digits: {}, draft: Array(digits).fill("") });
const notesKey = (code, round) => `sd:notes:${code}:${round}`;

function loadNotes(code, round, digitCount) {
  try {
    const raw = localStorage.getItem(notesKey(code, round));
    if (!raw) return emptyNotes(digitCount);
    const parsed = JSON.parse(raw);
    const digits = (parsed && typeof parsed.digits === "object" && parsed.digits) || {};
    const draftRaw = parsed && Array.isArray(parsed.draft) ? parsed.draft : null;
    const draft = Array.from({ length: digitCount }, (_, i) => {
      const v = draftRaw?.[i];
      return typeof v === "string" && /^\d$/.test(v) ? v : "";
    });
    return { digits, draft };
  } catch {
    return emptyNotes(digitCount);
  }
}

function saveNotes(code, round, notes) {
  try { localStorage.setItem(notesKey(code, round), JSON.stringify(notes)); } catch {}
}

// normal -> crossed out -> sure -> normal
function cycleMark(current) {
  if (current === undefined) return "cross";
  if (current === "cross") return "sure";
  return undefined;
}

export function usePlayerNotes(code, round, digitCount = 4) {
  const key = `${notesKey(code, round)}:${digitCount}`;
  const [loadedKey, setLoadedKey] = useState(key);
  const [notes, setNotes] = useState(() => loadNotes(code, round, digitCount));

  // Reset synchronously (during render) when the game/round/digit-count
  // changes, so we never persist stale notes under the new key.
  if (key !== loadedKey) {
    setLoadedKey(key);
    setNotes(loadNotes(code, round, digitCount));
  }

  useEffect(() => {
    saveNotes(code, round, notes);
  }, [code, round, notes]);

  const toggleDigit = useCallback((d) => {
    setNotes((prev) => {
      const digits = { ...prev.digits };
      const next = cycleMark(digits[d]);
      if (next === undefined) delete digits[d]; else digits[d] = next;
      return { ...prev, digits };
    });
  }, []);

  const setDraft = useCallback((nextDraft) => {
    setNotes((prev) => ({ ...prev, draft: nextDraft }));
  }, []);

  const clearDraft = useCallback(() => {
    setNotes((prev) => ({ ...prev, draft: Array(digitCount).fill("") }));
  }, [digitCount]);

  const clear = useCallback(() => setNotes(emptyNotes(digitCount)), [digitCount]);

  return { notes, toggleDigit, setDraft, clearDraft, clear };
}
