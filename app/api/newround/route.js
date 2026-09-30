import { newRound } from "@/lib/game";
import { postRoute } from "@/lib/http";

export const dynamic = "force-dynamic";

// Computer mode only: any active player presses "Next round" once the
// current one has ended. Rotating mode starts its next round automatically
// (see /api/pick) — newRound() itself rejects that mode with a clear error.
export const POST = postRoute("newround", ({ code, who }) => newRound(code, who));
