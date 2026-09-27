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
