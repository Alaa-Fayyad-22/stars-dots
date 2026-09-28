import { skipTurn } from "@/lib/game";

// Handles both the host/organizer's manual "skip turn" and the stuck-player
// fallback (anyone can skip once the current player's been inactive for
// 60+ seconds) — skipTurn() itself decides which one applies.
export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  const { code, playerId } = body;
  try {
    const out = await skipTurn(String(code || "").toUpperCase(), playerId);
    if (out.error) return Response.json(out, { status: 400 });
    return Response.json(out);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
