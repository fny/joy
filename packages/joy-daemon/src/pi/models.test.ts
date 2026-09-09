import { describe, expect, it } from "vitest";
import { humaniseModelId, parsePiModelList, staticPiCatalog } from "./models";

// Captured from `pi --list-models` on pi 0.84.1 (2026-09-09), trimmed.
const SAMPLE = `provider     model                                                     context  max-out  thinking  images
fireworks    accounts/fireworks/models/deepseek-v4-flash               1M       384K     yes       no
fireworks    accounts/fireworks/models/glm-5p2                         1.0M     131.1K   yes       no
fireworks    accounts/fireworks/models/kimi-k3                         1.0M     131.1K   yes       yes
fireworks    accounts/fireworks/routers/kimi-k3-fast                   1.0M     131.1K   yes       yes
huggingface  deepseek-ai/DeepSeek-V3                                   64K      8.2K     no        no
`;

describe("parsePiModelList", () => {
  it("turns the table into provider/model ids with the curated pair recommended and kimi-k3 default", () => {
    const rows = parsePiModelList(SAMPLE);
    expect(rows.map((r) => r.id)).toEqual([
      "fireworks/accounts/fireworks/models/deepseek-v4-flash",
      "fireworks/accounts/fireworks/models/glm-5p2",
      "fireworks/accounts/fireworks/models/kimi-k3",
      "fireworks/accounts/fireworks/routers/kimi-k3-fast",
      "huggingface/deepseek-ai/DeepSeek-V3",
    ]);
    expect(rows.filter((r) => r.recommended).map((r) => r.modelID)).toEqual(["accounts/fireworks/models/glm-5p2", "accounts/fireworks/models/kimi-k3"]);
    expect(rows.filter((r) => r.isDefault).map((r) => r.modelID)).toEqual(["accounts/fireworks/models/kimi-k3"]);
    expect(rows[4].thinking).toBe(false);
    expect(rows[0].thinking).toBe(true);
  });

  it("ignores banner lines before the header and colour codes", () => {
    const rows = parsePiModelList("\x1b[1mpi\x1b[22m warming up\n" + SAMPLE);
    expect(rows).toHaveLength(5);
  });

  it("with no curated model present the first row is the default", () => {
    const rows = parsePiModelList("provider model context\nhf x/y 1K\n");
    expect(rows[0].isDefault).toBe(true);
  });

  it("an empty listing parses to nothing (the caller falls back)", () => {
    expect(parsePiModelList("")).toEqual([]);
    expect(staticPiCatalog().map((m) => m.id)).toEqual(["fireworks/kimi-k3", "fireworks/glm-5.2"]);
  });
});

describe("humaniseModelId", () => {
  it("reads like the curated display names", () => {
    expect(humaniseModelId("accounts/fireworks/models/glm-5p2")).toBe("GLM 5.2");
    expect(humaniseModelId("accounts/fireworks/models/kimi-k3")).toBe("Kimi K3");
    expect(humaniseModelId("deepseek-ai/DeepSeek-V3")).toBe("DeepSeek V3");
    expect(humaniseModelId("accounts/fireworks/routers/kimi-k3-fast")).toBe("Kimi K3 Fast");
  });
});
