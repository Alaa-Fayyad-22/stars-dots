import { useCallback, useEffect, useState } from "react";

export function savePlayer(code, playerId) {
  try { localStorage.setItem(`sd:${code}`, playerId); } catch {}
}

export function loadPlayer(code) {
  try { return localStorage.getItem(`sd:${code}`); } catch { return null; }
}

export async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: "Something went wrong. Try again." }));
  if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
  return data;
}

// Keeps only digits, drops a digit that's already been typed (no repeats
// allowed), refuses a leading 0, and caps the result at 4 characters.
export const digitsOnly = (v) => {
  let out = "";
  for (const ch of String(v)) {
    if (!/\d/.test(ch) || out.includes(ch)) continue;
    if (out.length === 0 && ch === "0") continue;
    out += ch;
    if (out.length === 4) break;
  }
  return out;
};

// A number that follows the game's own digit rules: 4 different digits, not
// starting with 0. Mirrors lib/game.js's isFourDigits for client-side UI
// checks (e.g. enabling "Use as guess") — never imported from lib/game.js
// directly, since that module also pulls in the Redis client.
export function isValidNumber(value) {
  return typeof value === "string" && /^[1-9]\d{3}$/.test(value) && new Set(value).size === 4;
}

// --- Private per-player notes (never sent to the server) ---
// Stored per game code + round, so a new round always starts blank and a
// refresh doesn't lose anything.
const emptyNotes = () => ({ digits: {}, draft: ["", "", "", ""] });
const notesKey = (code, round) => `sd:notes:${code}:${round}`;

function loadNotes(code, round) {
  try {
    const raw = localStorage.getItem(notesKey(code, round));
    if (!raw) return emptyNotes();
    const parsed = JSON.parse(raw);
    const digits = (parsed && typeof parsed.digits === "object" && parsed.digits) || {};
    // Older saved notes may still have a `grid` field from a removed
    // position-grid feature — it's simply never read here, so it's dropped
    // the next time notes are saved.
    const draftRaw = parsed && Array.isArray(parsed.draft) ? parsed.draft : null;
    const draft = [0, 1, 2, 3].map((i) => {
      const v = draftRaw?.[i];
      return typeof v === "string" && /^\d$/.test(v) ? v : "";
    });
    return { digits, draft };
  } catch {
    return emptyNotes();
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

export function usePlayerNotes(code, round) {
  const key = notesKey(code, round);
  const [loadedKey, setLoadedKey] = useState(key);
  const [notes, setNotes] = useState(() => loadNotes(code, round));

  // Reset synchronously (during render) when the game/round changes, so we
  // never persist stale notes under the new key.
  if (key !== loadedKey) {
    setLoadedKey(key);
    setNotes(loadNotes(code, round));
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
    setNotes((prev) => ({ ...prev, draft: ["", "", "", ""] }));
  }, []);

  const clear = useCallback(() => setNotes(emptyNotes()), []);

  return { notes, toggleDigit, setDraft, clearDraft, clear };
}
