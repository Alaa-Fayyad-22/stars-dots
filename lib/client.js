import { useCallback, useEffect, useState } from "react";

export function savePlayer(code, playerId) {
  try { localStorage.setItem(`sd:${code}`, playerId); } catch {}
}

export function loadPlayer(code) {
  try { return localStorage.getItem(`sd:${code}`); } catch { return null; }
}

export function clearPlayer(code) {
  try { localStorage.removeItem(`sd:${code}`); } catch {}
}

export async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: "Something went wrong. Try again." }));
  if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
  return data;
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
