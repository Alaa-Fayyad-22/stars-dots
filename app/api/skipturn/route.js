import { skipTurn } from "@/lib/game";
import { postRoute } from "@/lib/http";

export const dynamic = "force-dynamic";

// Host-only (rotating) / organizer-only (computer), checked server-side.
export const POST = postRoute("skipturn", ({ code, who }) => skipTurn(code, who));
