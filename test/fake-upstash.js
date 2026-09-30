// A small in-memory fake of the Upstash Redis REST API, faithful enough to
// exercise the real @upstash/redis client: it accepts POSTs of JSON command
// arrays to the base URL (and to /pipeline), replies with
// `{ result }` / `{ error }`, and — since the SDK defaults to
// `Upstash-Encoding: base64` — base64-encodes string results exactly like
// the real service does, so the client's own base64-decoding path gets
// exercised too.
//
// Every command that runs is appended to `log`, so tests can inspect it
// (e.g. to confirm every key was written with an EX/24h expiry).

import http from "node:http";

export function createFakeUpstash() {
  const store = new Map(); // key -> { type: 'string'|'hash'|'list', value, expiresAt: number|null }
  const log = [];

  function getEntry(key) {
    const e = store.get(key);
    if (!e) return null;
    if (e.expiresAt != null && e.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return e;
  }

  function ensure(key, type, init) {
    let e = getEntry(key);
    if (!e) {
      e = { type, value: init(), expiresAt: null };
      store.set(key, e);
    }
    return e;
  }

  function exec(command) {
    const [cmdRaw, ...args] = command;
    const cmd = String(cmdRaw).toLowerCase();
    const key = typeof args[0] === "string" ? args[0] : undefined;
    log.push({ cmd, key, args: args.slice(), at: Date.now() });

    switch (cmd) {
      case "set": {
        const [k, value, ...opts] = args;
        const existing = getEntry(k);
        const flags = opts.map((s) => String(s).toLowerCase());
        if (flags.includes("nx") && existing) return null;
        if (flags.includes("xx") && !existing) return null;
        let expiresAt = existing?.expiresAt ?? null;
        const exIdx = flags.indexOf("ex");
        if (exIdx !== -1) expiresAt = Date.now() + Number(opts[exIdx + 1]) * 1000;
        if (!flags.includes("keepttl") && exIdx === -1) expiresAt = null;
        store.set(k, { type: "string", value: String(value), expiresAt });
        return "OK";
      }
      case "get": {
        const e = getEntry(args[0]);
        if (!e || e.type !== "string") return null;
        return e.value;
      }
      case "del": {
        let n = 0;
        for (const k of args) if (store.delete(k)) n++;
        return n;
      }
      case "expire": {
        const e = getEntry(args[0]);
        if (!e) return 0;
        if (String(args[2] || "").toLowerCase() === "nx" && e.expiresAt != null) return 0;
        e.expiresAt = Date.now() + Number(args[1]) * 1000;
        return 1;
      }
      case "ttl": {
        const e = getEntry(args[0]);
        if (!e) return -2;
        return e.expiresAt == null ? -1 : Math.max(0, Math.ceil((e.expiresAt - Date.now()) / 1000));
      }
      case "hset": {
        const [k, ...rest] = args;
        const e = ensure(k, "hash", () => new Map());
        let created = 0;
        for (let i = 0; i < rest.length; i += 2) {
          const f = String(rest[i]), v = String(rest[i + 1]);
          if (!e.value.has(f)) created++;
          e.value.set(f, v);
        }
        return created;
      }
      case "hsetnx": {
        const [k, field, value] = args;
        const e = ensure(k, "hash", () => new Map());
        if (e.value.has(String(field))) return 0;
        e.value.set(String(field), String(value));
        return 1;
      }
      case "hget": {
        const e = getEntry(args[0]);
        if (!e || e.type !== "hash") return null;
        const v = e.value.get(String(args[1]));
        return v === undefined ? null : v;
      }
      case "hgetall": {
        const e = getEntry(args[0]);
        if (!e || e.type !== "hash") return [];
        const out = [];
        for (const [f, v] of e.value) out.push(f, v);
        return out;
      }
      case "incr": {
        const e = getEntry(args[0]);
        const next = (e ? Number(e.value) : 0) + 1;
        store.set(args[0], { type: "string", value: String(next), expiresAt: e ? e.expiresAt : null });
        return next;
      }
      case "ltrim": {
        const [k, start, stop] = args;
        const e = getEntry(k);
        if (!e || e.type !== "list") return "OK";
        const len = e.value.length;
        let s = Number(start), t = Number(stop);
        if (s < 0) s = Math.max(len + s, 0);
        if (t < 0) t = len + t;
        t = Math.min(t, len - 1);
        e.value = s > t ? [] : e.value.slice(s, t + 1);
        if (!e.value.length) store.delete(k);
        return "OK";
      }
      case "rpush": {
        const [k, ...elements] = args;
        const e = ensure(k, "list", () => []);
        e.value.push(...elements.map(String));
        return e.value.length;
      }
      case "lrange": {
        const [k, start, stop] = args;
        const e = getEntry(k);
        if (!e || e.type !== "list") return [];
        const arr = e.value;
        const len = arr.length;
        let s = Number(start), t = Number(stop);
        if (s < 0) s = Math.max(len + s, 0);
        if (t < 0) t = len + t;
        t = Math.min(t, len - 1);
        if (s > t || len === 0) return [];
        return arr.slice(s, t + 1);
      }
      case "lrem": {
        const [k, count, value] = args;
        const e = getEntry(k);
        if (!e || e.type !== "list") return 0;
        const val = String(value);
        const n = Number(count);
        let removed = 0;
        if (n === 0) {
          const before = e.value.length;
          e.value = e.value.filter((v) => v !== val);
          removed = before - e.value.length;
        } else {
          const dir = n > 0 ? 1 : -1;
          let limit = Math.abs(n);
          const seq = dir > 0 ? e.value : [...e.value].reverse();
          const kept = [];
          for (const v of seq) {
            if (v === val && limit > 0) { limit--; removed++; continue; }
            kept.push(v);
          }
          e.value = dir > 0 ? kept : kept.reverse();
        }
        return removed;
      }
      default:
        throw new Error(`Unsupported command in fake Upstash: ${cmd}`);
    }
  }

  function b64(s) {
    return Buffer.from(s, "utf8").toString("base64");
  }

  function encodeResult(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "number" || typeof raw === "boolean") return raw;
    if (typeof raw === "string") return raw === "OK" ? raw : b64(raw);
    if (Array.isArray(raw)) {
      return raw.map((v) => {
        if (Array.isArray(v)) return v.map((x) => (typeof x === "string" && x !== "OK" ? b64(x) : x));
        if (typeof v === "string") return v === "OK" ? v : b64(v);
        return v;
      });
    }
    return raw;
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const useBase64 = String(req.headers["upstash-encoding"] || "").toLowerCase() === "base64";
      let parsed;
      try {
        const bodyText = Buffer.concat(chunks).toString("utf8");
        parsed = bodyText ? JSON.parse(bodyText) : null;
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `Bad JSON body: ${e.message}` }));
        return;
      }

      let payload;
      try {
        if (req.url && req.url.startsWith("/pipeline")) {
          payload = (parsed || []).map((command) => {
            try {
              const result = exec(command);
              return { result: useBase64 ? encodeResult(result) : result };
            } catch (e) {
              return { error: e.message };
            }
          });
        } else {
          const result = exec(parsed);
          payload = { result: useBase64 ? encodeResult(result) : result };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  return {
    server,
    log,
    store,
    async listen(port = 0) {
      await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
      const addr = server.address();
      return `http://127.0.0.1:${addr.port}`;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
