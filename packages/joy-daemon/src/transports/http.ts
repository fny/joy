// HTTP transport: a node:http router generated from the operation catalog,
// plus the debug-page extras that aren't operations (static HTML, SSE event
// stream). Localhost-only; mutating routes require the per-instance token
// printed at startup (H3: blocks drive-by cross-origin POSTs).
//
// Every catalog op is reachable here — same handlers the relay RPCs use, so
// the two surfaces cannot drift.

import { createServer, type IncomingMessage } from "http";
import { readFileSync } from "fs";
import { join } from "path";
import { machineOps, sessionOps, type HttpMethod, type MachineOp, type SessionOp } from "../domain/operations";
import { DirectoryCreationApprovalRequired, type SessionRegistry } from "../domain/registry";
import { buildOpenApiSpec } from "./openapi";

interface CompiledRoute {
  method: HttpMethod;
  regex: RegExp;
  paramNames: string[];
  op: MachineOp | SessionOp;
}

function compilePath(path: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const pattern = path
    .split("/")
    .map(seg => {
      if (seg.startsWith(":")) {
        paramNames.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^${pattern}$`), paramNames };
}

// Collect a request body and parse it as JSON. Empty / non-JSON bodies resolve
// to undefined (matches the Bun version's swallow-on-parse-error behavior).
let versionMemo: string | null = null;
function daemonVersion(): string {
  if (!versionMemo) {
    try {
      versionMemo = String(JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf-8")).version ?? "0.0.0");
    } catch {
      versionMemo = "0.0.0";
    }
  }
  return versionMemo;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  // 10MB cap: unbounded accumulation into a string let any local process OOM
  // the daemon (which holds live sessions) with one giant POST body.
  const MAX_BODY = 10 * 1024 * 1024;
  return new Promise(resolve => {
    let data = "";
    let overflow = false;
    req.on("data", chunk => {
      if (overflow) return;
      data += chunk;
      if (data.length > MAX_BODY) { overflow = true; data = ""; req.destroy(); resolve(undefined); }
    });
    req.on("end", () => { if (!overflow) { try { resolve(JSON.parse(data)); } catch { resolve(undefined); } } });
    req.on("error", () => resolve(undefined));
  });
}

export function startHttpServer(opts: {
  registry: SessionRegistry;
  port: number;
  publicDir: string;
  token: string;
  /** Fires with the BOUND port once listening — the daemon uses this to write
   *  the real port into daemon.json when it asked for a dynamic one (port 0). */
  onListening?: (port: number) => void;
}): void {
  const { registry, port, publicDir, token, onListening } = opts;

  const routes: CompiledRoute[] = [];
  for (const op of machineOps) {
    const { regex, paramNames } = compilePath(op.http.path);
    routes.push({ method: op.http.method, regex, paramNames, op });
  }
  for (const op of sessionOps) {
    if (!op.http) continue;
    const { regex, paramNames } = compilePath(op.http.path);
    routes.push({ method: op.http.method, regex, paramNames, op });
  }

  const allowedOrigins = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]);

  const server = createServer(async (req, res) => {
    const method = (req.method ?? "GET") as string;
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const origin = (req.headers.origin as string | undefined) ?? "";

    const corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Joy-Token",
    };
    // Only echo back known origins; unknown origins get no ACAO header (blocks reads)
    if (allowedOrigins.has(origin)) {
      corsHeaders["Access-Control-Allow-Origin"] = origin;
    }

    const send = (status: number, headers: Record<string, string>, body?: string) => {
      res.writeHead(status, headers);
      res.end(body);
    };
    const html = (file: string) => {
      let body: string;
      try {
        body = readFileSync(join(publicDir, file), "utf-8");
      } catch {
        // Missing static asset must not crash the daemon — 404 instead of throwing.
        return send(404, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" }, "not found");
      }
      return send(200, { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" }, body);
    };
    const json = (data: unknown, status = 200) =>
      send(status, { ...corsHeaders, "Content-Type": "application/json" }, JSON.stringify(data));

    try {
    if (method === "OPTIONS") return send(204, corsHeaders);

    // DNS-rebinding defense: a hostile page whose DNS flips to 127.0.0.1 makes
    // SAME-ORIGIN requests (no CORS involved) — but it necessarily carries its
    // own Host header. Reject anything not addressed to localhost, closing
    // unauthenticated GET exfiltration (/sessions/:id/log serves the full
    // transcript; /events streams chat history) while keeping the debug pages
    // browser-loadable via localhost.
    const host = String(req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
      return json({ error: "forbidden host" }, 403);
    }

    // Token check on all mutating routes
    if (method === "POST" || method === "DELETE") {
      if (req.headers["x-joy-token"] !== token) return json({ error: "unauthorized" }, 401);
    }

    // OpenAPI dump of the operation catalog — keyed even though it's a GET
    // (the API surface itself is not public information). Accepts the header,
    // a bearer, or ?token= (browser URLs can't set headers; localhost-only +
    // per-instance token makes the query form acceptable here).
    const openApiAuthed = () => {
      const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      return req.headers["x-joy-token"] === token || bearer === token || url.searchParams.get("token") === token;
    };
    if (method === "GET" && url.pathname === "/openapi.json") {
      if (!openApiAuthed()) return json({ error: "unauthorized" }, 401);
      const addr = server.address();
      const boundPort = addr && typeof addr === "object" ? addr.port : port;
      return json(buildOpenApiSpec({ port: boundPort, version: daemonVersion() }));
    }
    // Browsable API docs: /docs?token=… renders the spec with Redoc (CDN
    // script — the page runs in the user's browser, which can reach the CDN).
    if (method === "GET" && url.pathname === "/docs") {
      if (!openApiAuthed()) return json({ error: "unauthorized" }, 401);
      const specUrl = `/openapi.json?token=${encodeURIComponent(url.searchParams.get("token") ?? "")}`;
      const page = `<!doctype html><html><head><title>joy-daemon API</title>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0}</style></head><body>
<redoc spec-url="${specUrl}"></redoc>
<script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
</body></html>`;
      return send(200, { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" }, page);
    }

    // ── Debug-page extras (not operations) ──────────────────────────────

    if (method === "GET" && url.pathname === "/") return html("index.html");
    if (method === "GET" && /^\/session\/[^/]+$/.test(url.pathname)) return html("session.html");
    if (method === "GET" && /^\/session\/[^/]+\/screenshot$/.test(url.pathname)) return html("screenshot.html");

    if (method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const enqueue = (s: string) => res.write(s);
      enqueue(`event: history\ndata: ${JSON.stringify(registry.chatHistory())}\n\n`);
      enqueue(`event: sessions_history\ndata: ${JSON.stringify(registry.list().map(s => s.toJSON()))}\n\n`);
      const unsubscribe = registry.subscribeSse(enqueue);
      res.on("close", unsubscribe);
      return;
    }

    // ── Catalog routes ──────────────────────────────────────────────────

    for (const route of routes) {
      if (route.method !== method) continue;
      const match = url.pathname.match(route.regex);
      if (!match) continue;

      // Params: path captures + query string + JSON body (POST).
      const params: Record<string, unknown> = {};
      for (const [k, v] of url.searchParams) params[k] = v;
      if (method === "POST") {
        const body = await readJsonBody(req);
        if (body && typeof body === "object") Object.assign(params, body);
      }
      route.paramNames.forEach((name, i) => { params[name] = match[i + 1]; });

      try {
        if (route.op.scope === "machine") {
          const result = await route.op.handler(registry, params, { via: "http" });
          if (route.op.httpShape) {
            const shaped = route.op.httpShape(result);
            return json(shaped.body, shaped.status);
          }
          return json(result);
        }
        // Session-scoped: resolve the session from :id.
        const session = registry.get(String(params.id ?? ""));
        if (!session) return json({ error: "session_not_found" }, 404);
        const result = await route.op.handler(session, params);
        return json(result);
      } catch (e) {
        if (e instanceof DirectoryCreationApprovalRequired) {
          return json({ error: "dir_not_found", cwd: e.directory }, 422);
        }
        return json({ error: String(e) }, 500);
      }
    }

    return send(404, corsHeaders, "not found");
    } catch (e) {
      // Belt-and-suspenders: no single request may take the daemon down. Log
      // and 500 if the response hasn't started yet.
      process.stderr.write(`[http] request error: ${e}\n`);
      if (!res.headersSent) {
        try { send(500, { ...corsHeaders, "Content-Type": "application/json" }, JSON.stringify({ error: String(e) })); } catch { /* response already gone */ }
      }
    }
  });

  // Disable the idle-socket timeout so long-lived SSE (/events) responses
  // aren't dropped (the Bun version used idleTimeout: 0). Leave requestTimeout
  // and headersTimeout at their defaults — SSE is a long *response*, not a long
  // *request*, so those don't threaten it but do guard stuck request bodies.
  server.timeout = 0;
  // Belt-and-suspenders to the pidfile lock: if the port is already taken
  // (another daemon, or an unrelated process), exit cleanly instead of crashing
  // with an uncaught EADDRINUSE.
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      process.stderr.write(`[server] port ${port} already in use — another daemon? exiting.\n`);
      process.exit(1);
    }
    throw e;
  });
  server.listen(port, "127.0.0.1", () => {
    const addr = server.address();
    if (onListening && addr && typeof addr === "object") onListening(addr.port);
  });
}
