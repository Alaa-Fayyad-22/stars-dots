import { submitGuess } from "@/lib/game";
import { postRoute } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = postRoute("guess", ({ body, code, who }) => submitGuess(code, who, String(body.guess || "")));
