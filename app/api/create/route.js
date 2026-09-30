import { createRoom } from "@/lib/game";
import { postRoute } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = postRoute("create", ({ body }) => createRoom(body.name, body.pin, body.mode, Number(body.digits)));
