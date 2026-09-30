import { sendChatMessage } from "@/lib/game";
import { postRoute } from "@/lib/http";

export const dynamic = "force-dynamic";

export const POST = postRoute("chat", ({ body, code, who }) => sendChatMessage(code, who, { text: body.text, presetId: body.presetId }));
