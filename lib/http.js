// Shared plumbing for the API routes: every response is `no-store` (nothing
// game-related may ever be cached by the browser, Vercel or a CDN), a person's
// identity always comes from request headers — never the URL or body — and
// unexpected errors never echo internals (a database error can quote the
// command that failed, which may include the room record).
export const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export function reply(body, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

// `{ id, token }` from x-player-id / x-player-token.
export function whoOf(req) {
  return {
    id: (req.headers.get("x-player-id") || "").slice(0, 100),
    token: (req.headers.get("x-player-token") || "").slice(0, 300),
  };
}

// Turns a lib/game.js result ({ error, status? } or data) into a Response.
export function respond(out) {
  const { status, ...rest } = out;
  if (rest.error) return reply(rest, status || 400);
  return reply(rest);
}

const SAFE_ERRORS = ["Database not connected", "Couldn't generate a unique game code"];

export function crash(route, e) {
  // Log the kind of failure only — never the message, which may quote data.
  console.error(`[api] ${route} failed: ${e && e.name ? e.name : "Error"}`);
  const msg = e && typeof e.message === "string" ? e.message : "";
  const safe = SAFE_ERRORS.find((s) => msg.startsWith(s));
  return reply({ error: safe ? msg : "Something went wrong. Try again." }, 500);
}

// A POST route: parses the JSON body, hands `{ body, code, who }` to `run`,
// and turns whatever comes back into a response.
export function postRoute(route, run) {
  return async function POST(req) {
    let body;
    try { body = await req.json(); } catch { return reply({ error: "Invalid request." }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ error: "Invalid request." }, 400);
    try {
      return respond(await run({ body, code: String(body.code || "").toUpperCase(), who: whoOf(req) }));
    } catch (e) {
      return crash(route, e);
    }
  };
}
