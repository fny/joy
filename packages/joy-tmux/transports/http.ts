// HTTP transport: a Bun.serve router generated from the operation catalog,
// plus the debug-page extras that aren't operations (static HTML, SSE event
// stream). Localhost-only; mutating routes require the per-instance token
// printed at startup (H3: blocks drive-by cross-origin POSTs).
//
// Every catalog op is reachable here — same handlers the relay RPCs use, so
// the two surfaces cannot drift.

import { readFileSync } from "fs";
import { join } from "path";
import { machineOps, sessionOps, type HttpMethod, type MachineOp, type SessionOp } from "../operations";
import { DirectoryCreationApprovalRequired, type SessionRegistry } from "../registry";

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

  Bun.serve({
    port,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const method = req.method;
      const origin = req.headers.get("origin") ?? "";

      const corsHeaders: Record<string, string> = {
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Joy-Token",
      };
      // Only echo back known origins; unknown origins get no ACAO header (blocks reads)
      if (allowedOrigins.has(origin)) {
        corsHeaders["Access-Control-Allow-Origin"] = origin;
      }
      if (method === "OPTIONS") return new Response(null, { headers: corsHeaders });

      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

      // Token check on all mutating routes
      if (method === "POST" || method === "DELETE") {
        if (req.headers.get("X-Joy-Token") !== token) return json({ error: "unauthorized" }, 401);
      }

      // ── Debug-page extras (not operations) ──────────────────────────────

      if (method === "GET" && url.pathname === "/") {
        return new Response(readFileSync(join(publicDir, "index.html"), "utf-8"),
          { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (method === "GET" && /^\/session\/[^/]+$/.test(url.pathname)) {
        return new Response(readFileSync(join(publicDir, "session.html"), "utf-8"),
          { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (method === "GET" && /^\/session\/[^/]+\/screenshot$/.test(url.pathname)) {
        return new Response(readFileSync(join(publicDir, "screenshot.html"), "utf-8"),
          { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (method === "GET" && url.pathname === "/events") {
        const stream = new ReadableStream({
          start(ctrl) {
            const enc = new TextEncoder();
            const enqueue = (s: string) => ctrl.enqueue(enc.encode(s));
            enqueue(`event: history\ndata: ${JSON.stringify(registry.chatHistory())}\n\n`);
            enqueue(`event: sessions_history\ndata: ${JSON.stringify(registry.list().map(s => s.toJSON()))}\n\n`);
            const unsubscribe = registry.subscribeSse(enqueue);
            req.signal.addEventListener("abort", unsubscribe);
          },
        });
        return new Response(stream, {
          headers: {
            ...corsHeaders,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
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
          try {
            const body = await req.json();
            if (body && typeof body === "object") Object.assign(params, body);
          } catch { /* empty or non-JSON body is fine */ }
        }
        route.paramNames.forEach((name, i) => { params[name] = match[i + 1]; });

        try {
          let result: unknown;
          if (route.op.scope === "machine") {
            result = await route.op.handler(registry, params, { via: "http" });
            if (route.op.httpShape) {
              const shaped = route.op.httpShape(result);
              return json(shaped.body, shaped.status);
            }
            return json(result);
          }
          // Session-scoped: resolve the session from :id.
          const session = registry.get(String(params.id ?? ""));
          if (!session) return json({ error: "session_not_found" }, 404);
          result = await route.op.handler(session, params);
          return json(result);
        } catch (e) {
          if (e instanceof DirectoryCreationApprovalRequired) {
            return json({ error: "dir_not_found", cwd: e.directory }, 422);
          }
          return json({ error: String(e) }, 500);
        }
      }

      return new Response("not found", { status: 404 });
    },
  });
}
