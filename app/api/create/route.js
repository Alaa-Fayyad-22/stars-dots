import { createRoom, isFourDigits, cleanName } from "@/lib/game";

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  const { name, secret } = body;
  const hostName = cleanName(name);
  if (!hostName) return Response.json({ error: "Enter your name." }, { status: 400 });
  if (!isFourDigits(secret)) return Response.json({ error: "The secret must use 4 different digits, not starting with 0." }, { status: 400 });
  try {
    return Response.json(await createRoom(hostName, secret));
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
