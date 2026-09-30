import { getState } from "@/lib/game";
import { reply, whoOf, crash } from "@/lib/http";

export const dynamic = "force-dynamic";

// Who's asking comes from the x-player-id / x-player-token headers — never
// the URL, so it can't end up in browser history or server logs.
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const code = String(searchParams.get("code") || "").toUpperCase();
  try {
    const state = await getState(code, whoOf(req));
    if (!state) return reply({ error: "No game found with that code." }, 404);
    return reply(state);
  } catch (e) {
    return crash("state", e);
  }
}
