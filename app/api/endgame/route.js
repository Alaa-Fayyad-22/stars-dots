import { endGame } from "@/lib/game";
import { postRoute } from "@/lib/http";

export const dynamic = "force-dynamic";

// The host (rotating), the organizer (computer) or either player (duel) ends
// the whole game for everyone. Who's allowed is checked in endGame().
export const POST = postRoute("endgame", ({ code, who }) => endGame(code, who));
