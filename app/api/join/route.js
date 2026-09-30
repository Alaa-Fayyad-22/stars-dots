import { joinRoom } from "@/lib/game";
import { postRoute } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = postRoute("join", ({ body, code }) => joinRoom(code, body.name, body.pin));
