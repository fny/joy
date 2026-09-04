import { describe, it, expect } from "vitest";
import { buildOpenApiSpec } from "./openapi";

describe("buildOpenApiSpec", () => {
  const spec = buildOpenApiSpec({ port: 1234, version: "9.9.9" }) as any;

  it("is a 3.1 spec with keyed security and the bound server", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.version).toBe("9.9.9");
    expect(spec.servers[0].url).toBe("http://127.0.0.1:1234");
    expect(spec.security).toEqual([{ joyToken: [] }]);
    expect(spec.components.securitySchemes.joyToken.name).toBe("X-Joy-Token");
  });

  it("covers every HTTP op exactly once and rewrites :params", () => {
    expect(spec.paths["/sessions/{id}/queue/{qid}"].post).toBeTruthy();
    expect(spec.paths["/sessions"].get["x-rpc-name"]).toBe("joy-list-sessions");
    expect(spec.paths["/sessions"].post["x-rpc-name"]).toBe("joy-create-session");
    const methodCount = Object.values(spec.paths).reduce((n: number, p: any) => n + Object.keys(p).length, 0);
    expect(methodCount).toBe(59); // 60 ops - killSession (RPC-only)
  });

  it("annotated ops carry real schemas; path params never leak into bodies", () => {
    const create = spec.paths["/sessions"].post;
    expect(create.requestBody.content["application/json"].schema.required).toContain("cwd");
    const send = spec.paths["/send"].post;
    expect(send.requestBody.content["application/json"].schema.properties.text).toBeTruthy();
    const queueEdit = spec.paths["/sessions/{id}/queue/{qid}"].post;
    const bodyProps = queueEdit.requestBody.content["application/json"].schema.properties ?? {};
    expect(Object.keys(bodyProps)).not.toContain("id");
    expect(queueEdit.parameters.map((p: any) => p.name)).toEqual(["id", "qid"]);
  });

  it("GET query params come from the request schema", () => {
    const usage = spec.paths["/usage"].get;
    const q = usage.parameters.find((p: any) => p.name === "period");
    expect(q.in).toBe("query");
    expect(q.schema.enum).toContain("today");
  });

  it("RPC-only ops are listed, not pathed", () => {
    expect(spec["x-rpc-only"].map((o: any) => o.rpcName)).toContain("killSession");
  });
});
