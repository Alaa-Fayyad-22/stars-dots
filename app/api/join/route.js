import { joinRoom, cleanName } from "@/lib/game";

export async function POST(req) {
  const { code, name } = await req.json();
  const playerName = cleanName(name);
  if (!playerName) return Response.json({ error: "Enter your name." }, { status: 400 });
  try {
    const joined = await joinRoom(String(code || "").toUpperCase(), playerName);
    if (!joined) return Response.json({ error: "No game found with that code." }, { status: 404 });
    return Response.json(joined);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
