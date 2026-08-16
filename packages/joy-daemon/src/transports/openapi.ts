// OpenAPI 3.1 emitter — a third consumer of the operation catalog (after the
// HTTP router and the relay RPC binder), so the spec can never drift from the
// running surface. Generated at request time; GET /openapi.json serves it and
// REQUIRES the instance token like every mutating route (the API is not open).
//
// Op annotations are incremental: `summary` is set on every op; `params` /
// `result` JSON-Schema fragments exist on exemplar ops and default to
// permissive objects elsewhere. RPC-only ops (no HTTP route) are listed under
// the x-rpc-only extension instead of paths.

import { machineOps, sessionOps, type MachineOp, type SessionOp, type OpSchema } from "../domain/operations";

const PERMISSIVE: OpSchema = { type: "object", additionalProperties: true };

/** `/sessions/:id/queue/:qid` → `/sessions/{id}/queue/{qid}` + param names. */
function toOpenApiPath(path: string): { path: string; params: string[] } {
  const params: string[] = [];
  const converted = path.replace(/:([\w-]+)/g, (_, name: string) => {
    params.push(name);
    return `{${name}}`;
  });
  return { path: converted, params };
}

/** Drop path-parameter keys from a request schema — they're expressed as
 *  OpenAPI path parameters, not body/query fields. */
function omitProps(schema: OpSchema, names: string[]): OpSchema {
  const props = schema.properties as Record<string, unknown> | undefined;
  if (!props) return schema;
  const kept = Object.fromEntries(Object.entries(props).filter(([k]) => !names.includes(k)));
  const required = Array.isArray(schema.required) ? (schema.required as string[]).filter((r) => !names.includes(r)) : undefined;
  return { ...schema, properties: kept, ...(required ? { required } : {}) };
}

export function buildOpenApiSpec(opts: { port: number; version: string }): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const rpcOnly: Array<Record<string, unknown>> = [];

  const addOp = (op: MachineOp | SessionOp) => {
    if (!op.http) {
      rpcOnly.push({ rpcName: op.rpcName, scope: op.scope, summary: op.summary });
      return;
    }
    const { path, params: pathParams } = toOpenApiPath(op.http.path);
    const method = op.http.method.toLowerCase();
    const reqSchema = op.params ?? PERMISSIVE;

    const entry: Record<string, unknown> = {
      operationId: op.name === op.rpcName ? op.name : `${op.scope}.${op.name}`,
      summary: op.summary ?? op.name,
      tags: [op.scope],
      "x-rpc-name": op.rpcName,
      parameters: pathParams.map((name) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      })),
      responses: {
        "200": {
          description: "Success",
          content: { "application/json": { schema: op.result ?? PERMISSIVE } },
        },
        "401": { description: "Missing or wrong X-Joy-Token" },
      },
    };
    if (method === "get") {
      // Query params: request-schema properties minus path params.
      const q = omitProps(reqSchema, pathParams);
      const props = (q.properties ?? {}) as Record<string, OpSchema>;
      (entry.parameters as unknown[]).push(...Object.entries(props).map(([name, schema]) => ({
        name,
        in: "query",
        required: Array.isArray(q.required) && (q.required as string[]).includes(name),
        schema,
      })));
    } else {
      entry.requestBody = {
        required: false,
        content: { "application/json": { schema: omitProps(reqSchema, pathParams) } },
      };
    }
    (paths[path] ??= {})[method] = entry;
  };

  for (const op of machineOps) addOp(op);
  for (const op of sessionOps) addOp(op);

  return {
    openapi: "3.1.0",
    info: {
      title: "joy-daemon API",
      version: opts.version,
      description: "Per-machine agent-session daemon. Same operation catalog as the relay RPC surface (x-rpc-name maps each route to its RPC form). All routes require the per-instance token.",
    },
    servers: [{ url: `http://127.0.0.1:${opts.port}` }],
    security: [{ joyToken: [] }],
    components: {
      securitySchemes: {
        joyToken: {
          type: "apiKey",
          in: "header",
          name: "X-Joy-Token",
          description: "Per-instance token from ~/.joy/**/state/daemon.json (printed at startup)",
        },
      },
    },
    paths,
    "x-rpc-only": rpcOnly,
  };
}
