import { submitGuess, isFourDigits } from "@/lib/game";

export async function POST(req) {
  const { code, playerId, guess } = await req.json();
  if (!isFourDigits(guess)) return Response.json({ error: "A guess must use 4 different digits, not starting with 0." }, { status: 400 });
  try {
    const out = await submitGuess(String(code || "").toUpperCase(), playerId, guess);
    if (out.error) return Response.json(out, { status: 400 });
    return Response.json(out);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
