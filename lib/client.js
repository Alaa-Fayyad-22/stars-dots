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

export const digitsOnly = (v) => v.replace(/\D/g, "").slice(0, 4);
