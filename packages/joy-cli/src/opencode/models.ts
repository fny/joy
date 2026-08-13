// Curated opencode model allowlist (v1 policy, see
// docs/plans/opencode-adapter-design.md): joy exposes exactly these two
// fireworks-hosted models rather than opencode's full catalog (241 models on a
// typical install). The architecture stays provider-blind — an OpencodeSession
// runs whatever {providerID, model} it's given; only THIS list is opinionated,
// and later versions can source it from GET /api/model instead.
//
// Full accounts/… ids are required: fireconnect's alias ids (kimi-latest etc.)
// 401 at the gateway (verified live 2026-08-01).

export interface OpencodeModel {
  id: string;          // provider-native model id (opencode model id)
  providerID: string;  // opencode provider key
  displayName: string;
  isDefault: boolean;
}

export const OPENCODE_MODELS: OpencodeModel[] = [
  {
    id: "accounts/fireworks/models/kimi-k3",
    providerID: "fireworks-ai",
    displayName: "Kimi K3",
    isDefault: true,
  },
  {
    id: "accounts/fireworks/models/glm-5p2",
    providerID: "fireworks-ai",
    displayName: "GLM 5.2",
    isDefault: false,
  },
];

export function defaultOpencodeModel(): OpencodeModel {
  return OPENCODE_MODELS.find((m) => m.isDefault) ?? OPENCODE_MODELS[0];
}
