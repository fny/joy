// pi models: the curated pair (bare v1, docs/plans/pi-family-adapter-design.md)
// stays as the RECOMMENDED subset and the fallback; the full catalog comes
// from `pi --list-models` (a table pi prints from its own provider catalogs),
// memoised for ten minutes. The app keeps its own per-harness allowlist over
// this catalog, so the picker never has to show all of it.
//
// A catalog id is "<provider>/<model id>", which is exactly what `pi --model`
// takes ("supports provider/id"). NOTE: the bare spec "fireworks/kimi-k3"
// fuzzy-resolves to the -fast router on pi 0.84.1; the full path pins the
// base model.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

/** One row of the live catalog (the shape GET /v2/harnesses/pi/models serves). */
export interface PiCatalogModel {
  /** "<provider>/<model id>" — what `pi --model` takes. */
  id: string;
  providerID: string;
  modelID: string;
  displayName: string;
  isDefault: boolean;
  /** The curated pair: what a fresh allowlist shows. */
  recommended: boolean;
  /** pi reports whether the model supports thinking (the --thinking knob). */
  thinking: boolean;
}

/** The curated pair, by the tail of their catalog ids. */
const RECOMMENDED_TAILS = ["/models/kimi-k3", "/models/glm-5p2"];
const DEFAULT_TAIL = "/models/kimi-k3";

/** "accounts/fireworks/models/glm-5p2" → "GLM 5.2"; "deepseek-ai/DeepSeek-V3" → "DeepSeek V3". */
export function humaniseModelId(modelID: string): string {
  const tail = modelID.split("/").pop() ?? modelID;
  return tail
    .replace(/(\d)p(\d)/g, "$1.$2")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => (/^[a-z]{1,3}\d*$/.test(w) ? w.toUpperCase() : /^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Parse `pi --list-models` output. Header first; columns are blank-separated
 *  and the first two (provider, model) never contain blanks. Exported for
 *  its test. */
export function parsePiModelList(stdout: string): PiCatalogModel[] {
  const out: PiCatalogModel[] = [];
  const lines = stdout.split("\n");
  let header: string[] | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
    if (!line.trim()) continue;
    const cols = line.trim().split(/\s+/);
    if (!header) {
      if (cols[0] === "provider" && cols[1] === "model") { header = cols; continue; }
      continue; // banner / warning lines before the table
    }
    if (cols.length < 2) continue;
    const [providerID, modelID] = cols;
    const thinkingIdx = header.indexOf("thinking");
    const thinking = thinkingIdx >= 0 ? (cols[thinkingIdx] ?? "").toLowerCase() === "yes" : false;
    const id = `${providerID}/${modelID}`;
    const tailMatch = (t: string) => modelID.endsWith(t) || modelID === t.replace("/models/", "");
    out.push({
      id, providerID, modelID,
      displayName: humaniseModelId(modelID),
      isDefault: tailMatch(DEFAULT_TAIL),
      recommended: RECOMMENDED_TAILS.some(tailMatch),
      thinking,
    });
  }
  // Exactly one default: the curated one if present, else the first row.
  if (out.length && !out.some((m) => m.isDefault)) out[0].isDefault = true;
  return out;
}

/** The static pair in catalog shape — what the list falls back to when pi is
 *  absent or its listing fails, so a picker is never empty. */
export function staticPiCatalog(): PiCatalogModel[] {
  return PI_MODELS.map((m) => ({
    id: m.spec, providerID: m.spec.split("/")[0], modelID: m.spec.split("/").slice(1).join("/"),
    displayName: m.displayName, isDefault: m.isDefault, recommended: true, thinking: true,
  }));
}

function piBinary(): string {
  for (const p of (process.env.PATH ?? "").split(":")) {
    if (p && existsSync(join(p, "pi"))) return join(p, "pi");
  }
  const pnpmShim = join(homedir(), ".local", "share", "pnpm", "pi");
  if (existsSync(pnpmShim)) return pnpmShim;
  return "pi";
}

const CATALOG_TTL_MS = 10 * 60_000;
let memo: { at: number; value: Promise<PiCatalogModel[]> } | null = null;
let last: PiCatalogModel[] | null = null;

/** The live catalog, memoised; the static pair when pi cannot be asked. */
export function listPiModels(): Promise<PiCatalogModel[]> {
  if (memo && Date.now() - memo.at < CATALOG_TTL_MS) return memo.value;
  const value = new Promise<PiCatalogModel[]>((resolve) => {
    execFile(piBinary(), ["--list-models"], { timeout: 20_000, env: process.env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const parsed = err ? [] : parsePiModelList(String(stdout));
      if (parsed.length === 0) {
        memo = null; // retry next time rather than caching a failure
        resolve(last ?? staticPiCatalog());
        return;
      }
      last = parsed;
      resolve(parsed);
    });
  });
  memo = { at: Date.now(), value };
  return value;
}

/** What the catalog last reported, without asking pi (null before the first
 *  successful listing). Create-time validation reads this. */
export function knownPiModels(): PiCatalogModel[] | null { return last; }

/** Test seam. */
export function resetPiModelsCache(): void { memo = null; last = null; }
