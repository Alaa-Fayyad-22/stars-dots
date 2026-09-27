import { getState } from "@/lib/game";

export const dynamic = "force-dynamic";

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const code = String(searchParams.get("code") || "").toUpperCase();
  try {
    const state = await getState(code, searchParams.get("playerId"));
    if (!state) return Response.json({ error: "No game found with that code." }, { status: 404 });
    return Response.json(state, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
