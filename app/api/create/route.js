import { createRoom, isFourDigits, cleanName } from "@/lib/game";

export async function POST(req) {
  const { name, secret } = await req.json();
  const hostName = cleanName(name);
  if (!hostName) return Response.json({ error: "Enter your name." }, { status: 400 });
  if (!isFourDigits(secret)) return Response.json({ error: "The secret must use 4 different digits, not starting with 0." }, { status: 400 });
  try {
    return Response.json(await createRoom(hostName, secret));
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
