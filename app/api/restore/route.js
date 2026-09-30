import { restorePlayer } from "@/lib/game";
import { postRoute } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = postRoute("restore", ({ body, code, who }) => restorePlayer(code, who, body.targetPlayerId));
