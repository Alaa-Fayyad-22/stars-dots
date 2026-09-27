import { newRound, isFourDigits } from "@/lib/game";

export async function POST(req) {
  const { code, playerId, secret } = await req.json();
  if (!isFourDigits(secret)) return Response.json({ error: "The secret must be exactly 4 digits." }, { status: 400 });
  const out = await newRound(code, playerId, secret);
  if (out.error) return Response.json(out, { status: 400 });
  return Response.json(out);
}
