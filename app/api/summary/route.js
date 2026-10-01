import { getSummary } from "@/lib/game";
import { respond, whoOf, crash } from "@/lib/http";

export const dynamic = "force-dynamic";

// Standings and awards so far, worked out from the saved round details only
// when someone opens the summary — never as part of the state poll.
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const code = String(searchParams.get("code") || "").toUpperCase();
  try {
    return respond(await getSummary(code, whoOf(req)));
  } catch (e) {
    return crash("summary", e);
  }
}
