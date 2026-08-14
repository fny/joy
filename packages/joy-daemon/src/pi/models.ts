// Curated pi model allowlist (bare v1, see docs/plans/pi-family-adapter-design.md).
// The spec string is what `pi --model` receives (provider/model fuzzy match);
// pi resolves it against its own catalog. NOTE: "fireworks/kimi-k3" resolves to
// the -fast router variant on pi 0.84.1 (verified live) — pinning the exact
// base model id is a TODO; the resolved id is reported back via get_state and
// surfaced as currentModel.

export interface PiModel {
  spec: string;        // pi --model argument
  displayName: string;
  isDefault: boolean;
}

export const PI_MODELS: PiModel[] = [
  { spec: "fireworks/kimi-k3", displayName: "Kimi K3", isDefault: true },
  { spec: "fireworks/glm-5.2", displayName: "GLM 5.2", isDefault: false },
];

export function defaultPiModel(): PiModel {
  return PI_MODELS.find((m) => m.isDefault) ?? PI_MODELS[0];
}
