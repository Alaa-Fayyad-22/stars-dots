import { pickSecret } from "@/lib/game";
import { postRoute } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = postRoute("pick", ({ body, code, who }) => pickSecret(code, who, String(body.secret || "")));
