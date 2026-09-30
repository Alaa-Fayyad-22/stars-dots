import { comeBack } from "@/lib/game";
import { postRoute } from "@/lib/http";

export const dynamic = "force-dynamic";

// Someone who left comes back on the same device, with their token (no PIN).
export const POST = postRoute("comeback", ({ code, who }) => comeBack(code, who));
