import { newRound } from "@/lib/game";

// Computer mode only: any active player presses "Next round" once the
// current one has ended. Rotating mode starts its next round automatically
// (see /api/pick) — newRound() itself rejects that mode with a clear error.
export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  const { code, playerId } = body;
  try {
    const out = await newRound(String(code || "").toUpperCase(), playerId);
    if (out.error) return Response.json(out, { status: 400 });
    return Response.json(out);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
