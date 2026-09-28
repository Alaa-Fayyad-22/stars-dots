import { submitGuess } from "@/lib/game";

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  const { code, playerId, guess } = body;
  try {
    const out = await submitGuess(String(code || "").toUpperCase(), playerId, String(guess || ""));
    if (out.error) return Response.json(out, { status: 400 });
    return Response.json(out);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
