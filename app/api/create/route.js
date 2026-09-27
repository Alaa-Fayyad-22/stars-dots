import { createRoom, isFourDigits, cleanName } from "@/lib/game";

export async function POST(req) {
  const { name, secret } = await req.json();
  const hostName = cleanName(name);
  if (!hostName) return Response.json({ error: "Enter your name." }, { status: 400 });
  if (!isFourDigits(secret)) return Response.json({ error: "The secret must be exactly 4 digits." }, { status: 400 });
  return Response.json(await createRoom(hostName, secret));
}
