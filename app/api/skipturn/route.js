import { skipTurn } from "@/lib/game";

export async function POST(req) {
  const { code, playerId } = await req.json();
  try {
    const out = await skipTurn(String(code || "").toUpperCase(), playerId);
    if (out.error) return Response.json(out, { status: 400 });
    return Response.json(out);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
