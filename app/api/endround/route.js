import { endRound } from "@/lib/game";
import { postRoute } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = postRoute("endround", ({ code, who }) => endRound(code, who));
