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

type HttpResponses = Record<string, { description: string; schema: OpSchema }>;
const ERROR_BODY: OpSchema = { type: "object", properties: { error: { type: "string" } }, required: ["error"] };
const err = (description: string) => ({ description, schema: ERROR_BODY });
const success = (op: MachineOp | SessionOp) => ({ description: "Success", schema: op.result ?? PERMISSIVE });
const SESSION_RECORD: OpSchema = { type: "object", description: "SessionRecord — the created session itself, UNWRAPPED (not the RPC's {ok, session})", additionalProperties: true };

/**
 * HTTP contracts for the ops whose `httpShape` (operations.ts) diverges from
 * "200 + the RPC result". The emitter used to document the RPC result under a
 * hard-coded 200 for these too, so a client generated from /openapi.json
 * waited for a 200 with `result.session` on POST /sessions while the wire
 * carried a 201 with the bare SessionRecord (#598). The shapes themselves stay
 * in operations.ts; this table mirrors them, and the test suite fails when an
 * op gains an httpShape without a row here.
 */
const HTTP_SHAPED: Record<string, (op: MachineOp) => HttpResponses> = {
  create: () => ({ "201": { description: "Created", schema: SESSION_RECORD }, "400": err("cwd required"), "500": err("spawn failed — {error}") }),
  get: (op) => ({ "200": success(op), "404": err("session_not_found") }),
  kill: (op) => ({ "200": success(op), "404": err("session_not_found"), "409": err("status_mismatch — ifStatus did not match the live status") }),
  send: (op) => ({ "200": success(op), "400": err("empty"), "404": err("session_not_found"), "409": err("busy | mode_not_scriptable"), "503": err("not_durable") }),
  queueList: (op) => ({ "200": success(op), "404": err("session_not_found") }),
  queueAdd: (op) => ({ "200": success(op), "400": err("empty"), "404": err("session_not_found"), "503": err("not_durable") }),
  sendKeys: (op) => ({ "200": success(op), "400": err("empty"), "404": err("session_not_found") }),
  setMode: (op) => ({ "200": success(op), "404": err("session_not_found") }),
  pane: (op) => ({ "200": success(op), "404": err("session_not_found") }),
  resize: (op) => ({ "200": success(op), "400": err("bad dimensions"), "404": err("session_not_found") }),
  transcript: (op) => ({ "200": success(op), "404": err("session_not_found") }),
  check: (op) => ({ "200": success(op), "404": err("session_not_found") }),
  approvalsList: (op) => ({ "200": success(op), "404": err("session_not_found") }),
  approvalsAnswer: (op) => ({ "200": success(op), "400": err("unknown approval | approvals_unsupported") }),
  envSet: (op) => ({ "200": success(op), "400": err("bad_name | bad_value | no_machine_key | store_unreadable") }),
  envUnset: (op) => ({ "200": success(op), "400": err("bad_name | store_unreadable") }),
  // Refusals stay app-facing sentences at 200 ({ok:false, error}); only a
  // refused spool commit is a retryable 503, like send/queueAdd (#53).
  handoff: (op) => ({ "200": success(op), "503": err("not_durable") }),
  handback: (op) => ({ "200": success(op), "503": err("not_durable") }),
};

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
    // A shaped op documents what the HTTP router actually sends (#598); the
    // rest answer 200 with the RPC result verbatim.
    const shaped = op.scope === "machine" && op.httpShape ? HTTP_SHAPED[op.name]?.(op) : undefined;
    const responses: HttpResponses = shaped ?? { "200": success(op) };

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
        ...Object.fromEntries(Object.entries(responses).map(([status, r]) => [status, {
          description: r.description,
          content: { "application/json": { schema: r.schema } },
        }])),
        "401": { description: "Missing or wrong X-Joy-Token" },
      },
    };
    if (shaped) entry["x-http-shaped"] = true;
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
