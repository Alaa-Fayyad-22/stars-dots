import { getReplay } from "@/lib/game";
import { respond, reply, whoOf, crash } from "@/lib/http";

export const dynamic = "force-dynamic";

// One finished round's replay. Loaded only when someone opens it — never as
// part of the state poll. Who's asking comes from the x-player-id /
// x-player-token headers (like /api/state), never the URL.
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const code = String(searchParams.get("code") || "").toUpperCase();
  const round = searchParams.get("round");
  if (!/^\d{1,6}$/.test(String(round || ""))) return reply({ error: "Invalid request." }, 400);
  try {
    return respond(await getReplay(code, whoOf(req), round));
  } catch (e) {
    return crash("replay", e);
  }
}
