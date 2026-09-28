import { rejoinRoom } from "@/lib/game";

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  const { code, name, pin } = body;
  try {
    const out = await rejoinRoom(String(code || "").toUpperCase(), name, pin);
    if (out.error) return Response.json(out, { status: out.error.includes("No game found") ? 404 : 400 });
    return Response.json(out);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
