import { sendChatMessage } from "@/lib/game";

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  const { code, playerId, text, presetId } = body;
  try {
    const out = await sendChatMessage(String(code || "").toUpperCase(), playerId, { text, presetId });
    if (out.error) return Response.json({ error: out.error }, { status: out.status || 400 });
    return Response.json(out);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
