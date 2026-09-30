import { removePlayer } from "@/lib/game";
import { postRoute } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = postRoute("remove", ({ body, code, who }) => removePlayer(code, who, body.targetPlayerId));
