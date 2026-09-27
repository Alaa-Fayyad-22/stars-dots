import { submitGuess, isFourDigits } from "@/lib/game";

export async function POST(req) {
  const { code, playerId, guess } = await req.json();
  if (!isFourDigits(guess)) return Response.json({ error: "A guess must be exactly 4 different digits." }, { status: 400 });
  const out = await submitGuess(code, playerId, guess);
  if (out.error) return Response.json(out, { status: 400 });
  return Response.json(out);
}
