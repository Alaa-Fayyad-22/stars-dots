import { leaveGame } from "@/lib/game";
import { postRoute } from "@/lib/http";

export const dynamic = "force-dynamic";

// Anyone in the game can leave (and come back later).
export const POST = postRoute("leave", ({ code, who }) => leaveGame(code, who));
