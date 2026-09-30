import { rejoinRoom } from "@/lib/game";
import { postRoute } from "@/lib/http";

export const dynamic = "force-dynamic";

// Name + PIN, from any device. Answers with a fresh private token.
export const POST = postRoute("rejoin", ({ body, code }) => rejoinRoom(code, body.name, body.pin));
