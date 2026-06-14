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
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise(resolve => {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(undefined); } });
    req.on("error", () => resolve(undefined));
  });
}

export function startHttpServer(opts: {
  registry: SessionRegistry;
  port: number;
  publicDir: string;
  token: string;
}): void {
  const { registry, port, publicDir, token } = opts;

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
    const html = (file: string) =>
      send(200, { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
        readFileSync(join(publicDir, file), "utf-8"));
    const json = (data: unknown, status = 200) =>
      send(status, { ...corsHeaders, "Content-Type": "application/json" }, JSON.stringify(data));

    if (method === "OPTIONS") return send(204, corsHeaders);

    // Token check on all mutating routes
    if (method === "POST" || method === "DELETE") {
      if (req.headers["x-joy-token"] !== token) return json({ error: "unauthorized" }, 401);
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
  });

  // Disable timeouts so long-lived SSE (/events) connections aren't dropped
  // (the Bun version used idleTimeout: 0).
  server.timeout = 0;
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.listen(port, "127.0.0.1");
}
