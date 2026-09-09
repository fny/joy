import { beforeEach, describe, expect, it } from "vitest";
import { catalogFromProviders, resetOpencodeModelsCache, resolveOpencodeModel, staticOpencodeCatalog, type ProviderPayload } from "./models";

const payload: ProviderPayload = {
  all: [
    { id: "fireworks-ai", name: "Fireworks", models: {
      "accounts/fireworks/models/kimi-k3": { id: "accounts/fireworks/models/kimi-k3", name: "Kimi K3 (Latest)", variants: { high: {}, low: {} } },
      "accounts/fireworks/models/glm-5p2": { id: "accounts/fireworks/models/glm-5p2", name: "GLM 5.2" },
      "accounts/fireworks/models/qwen3p8-max": { id: "accounts/fireworks/models/qwen3p8-max", name: "Qwen 3.8 Max" },
    } },
    { id: "huggingface", name: "Hugging Face", models: { "deepseek-ai/DeepSeek-V3": { id: "deepseek-ai/DeepSeek-V3", name: "DeepSeek V3" } } },
    { id: "openai", name: "OpenAI", models: { "gpt-5.6": { id: "gpt-5.6", name: "GPT-5.6" } } },
  ],
  connected: ["fireworks-ai", "huggingface"],
  default: {},
};

beforeEach(() => resetOpencodeModelsCache());

describe("catalogFromProviders", () => {
  it("keeps connected providers, recommends the curated pair first, kimi-k3 default, variants as effort levels", () => {
    const rows = catalogFromProviders(payload);
    expect(rows.map((r) => r.id)).toEqual([
      "fireworks-ai/accounts/fireworks/models/glm-5p2",
      "fireworks-ai/accounts/fireworks/models/kimi-k3",
      "fireworks-ai/accounts/fireworks/models/qwen3p8-max",
      "huggingface/deepseek-ai/DeepSeek-V3",
    ]);
    const kimi = rows.find((r) => r.modelID.endsWith("kimi-k3"))!;
    expect(kimi.isDefault).toBe(true);
    expect(kimi.recommended).toBe(true);
    expect(kimi.variants).toEqual(["high", "low"]);
    expect(kimi.displayName).toBe("Kimi K3 (Latest)");
    expect(rows.find((r) => r.providerID === "openai")).toBeUndefined();
  });

  it("with no connected list every provider is taken; a catalog without a curated model still has one default", () => {
    const rows = catalogFromProviders({ all: payload.all!.slice(2) });
    expect(rows.map((r) => r.id)).toEqual(["openai/gpt-5.6"]);
    expect(rows[0].isDefault).toBe(true);
    expect(rows[0].recommended).toBe(false);
  });

  it("the static fallback is the curated pair in the same shape", () => {
    expect(staticOpencodeCatalog().map((m) => m.id)).toEqual([
      "fireworks-ai/accounts/fireworks/models/kimi-k3",
      "fireworks-ai/accounts/fireworks/models/glm-5p2",
    ]);
  });
});

describe("resolveOpencodeModel", () => {
  it("accepts the old bare curated id, the catalog id, and splits an unknown spec at the first slash when nothing is loaded", () => {
    expect(resolveOpencodeModel("accounts/fireworks/models/glm-5p2")).toMatchObject({ providerID: "fireworks-ai", modelID: "accounts/fireworks/models/glm-5p2" });
    expect(resolveOpencodeModel("fireworks-ai/accounts/fireworks/models/glm-5p2")).toMatchObject({ providerID: "fireworks-ai", modelID: "accounts/fireworks/models/glm-5p2" });
    expect(resolveOpencodeModel("anthropic/claude-x")).toEqual({ providerID: "anthropic", modelID: "claude-x", variants: [] });
    expect(resolveOpencodeModel("nonsense")).toBeNull();
    expect(resolveOpencodeModel(undefined)).toMatchObject({ modelID: "accounts/fireworks/models/kimi-k3" });
  });
});
