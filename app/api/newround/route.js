import { newRound, isFourDigits } from "@/lib/game";

export async function POST(req) {
  const { code, playerId, secret } = await req.json();
  if (!isFourDigits(secret)) return Response.json({ error: "The secret must be exactly 4 different digits." }, { status: 400 });
  try {
    const out = await newRound(String(code || "").toUpperCase(), playerId, secret);
    if (out.error) return Response.json(out, { status: 400 });
    return Response.json(out);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
