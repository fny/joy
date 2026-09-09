// opencode models. The curated fireworks pair (v1 policy, see
// docs/plans/opencode-adapter-design.md) stays as the RECOMMENDED subset and
// the fallback; the full catalog is what the server itself reports from
// GET /provider (241 models on a typical install), memoised for ten minutes.
// The app keeps its own per-harness allowlist over this, so the picker never
// has to show all of it — but the daemon accepts any model the server knows.
//
// Full accounts/… ids are required for fireworks: fireconnect's alias ids
// (kimi-latest etc.) 401 at the gateway (verified live 2026-08-01).
import { homedir } from "node:os";

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

/** One row of the live catalog (the shape GET /v2/harnesses/opencode/models serves). */
export interface OpencodeCatalogModel {
  /** "<providerID>/<modelID>" — the app's stable handle; providerIDs never contain "/". */
  id: string;
  providerID: string;
  modelID: string;
  displayName: string;
  isDefault: boolean;
  /** The curated pair: what a fresh allowlist shows. */
  recommended: boolean;
  /** Reasoning variants (the model's `variants` keys) — its effort levels. */
  variants: string[];
}

/** The curated pair in catalog shape. */
export function staticOpencodeCatalog(): OpencodeCatalogModel[] {
  return OPENCODE_MODELS.map((m) => ({
    id: `${m.providerID}/${m.id}`, providerID: m.providerID, modelID: m.id,
    displayName: m.displayName, isDefault: m.isDefault, recommended: true, variants: [],
  }));
}

export interface ProviderPayload {
  all?: Array<{ id?: string; name?: string; models?: Record<string, { id?: string; name?: string; variants?: Record<string, unknown> }> }>;
  connected?: string[];
  default?: Record<string, string>;
}

/** GET /provider → catalog rows. Providers the server reports as connected
 *  (a key or login present) win; with no `connected` list every provider is
 *  taken. Exported for its test. */
export function catalogFromProviders(payload: ProviderPayload): OpencodeCatalogModel[] {
  const curated = new Map(OPENCODE_MODELS.map((m) => [`${m.providerID}/${m.id}`, m]));
  const connected = Array.isArray(payload.connected) && payload.connected.length > 0 ? new Set(payload.connected) : null;
  const out: OpencodeCatalogModel[] = [];
  for (const p of payload.all ?? []) {
    const providerID = typeof p.id === "string" ? p.id : "";
    if (!providerID || (connected && !connected.has(providerID))) continue;
    for (const [key, m] of Object.entries(p.models ?? {})) {
      const modelID = typeof m?.id === "string" && m.id ? m.id : key;
      const id = `${providerID}/${modelID}`;
      const c = curated.get(id);
      out.push({
        id, providerID, modelID,
        displayName: typeof m?.name === "string" && m.name ? m.name : (c?.displayName ?? modelID),
        isDefault: c?.isDefault === true,
        recommended: c !== undefined,
        variants: m?.variants && typeof m.variants === "object" ? Object.keys(m.variants) : [],
      });
    }
  }
  out.sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.id.localeCompare(b.id));
  if (out.length && !out.some((m) => m.isDefault)) out[0].isDefault = true;
  return out;
}

const CATALOG_TTL_MS = 10 * 60_000;
let memo: { at: number; value: Promise<OpencodeCatalogModel[]> } | null = null;
let last: OpencodeCatalogModel[] | null = null;

/** The live catalog via a short-lived server (one boot, ~2-4s), memoised;
 *  the curated pair when the server cannot be asked. Never throws. */
export function listOpencodeModels(): Promise<OpencodeCatalogModel[]> {
  if (memo && Date.now() - memo.at < CATALOG_TTL_MS) return memo.value;
  const value = (async () => {
    try {
      const { spawnOpencodeServer, OpencodeClient, killOpencodeServerPid } = await import("./opencodeClient");
      const { proc, port, marker, startedAt, group } = spawnOpencodeServer(homedir());
      try {
        const p = await port;
        const client = new OpencodeClient(p);
        const payload = await client.request<ProviderPayload>("GET", "/provider", undefined, 20_000);
        const rows = catalogFromProviders(payload ?? {});
        if (rows.length === 0) throw new Error("opencode reported no models");
        last = rows;
        return rows;
      } finally {
        if (proc.pid) void killOpencodeServerPid(proc.pid, marker, startedAt, group);
      }
    } catch (e) {
      process.stderr.write(`[opencode] model catalog unavailable (${e instanceof Error ? e.message : e}) — serving the curated pair\n`);
      memo = null; // retry next time rather than caching a failure
      return last ?? staticOpencodeCatalog();
    }
  })();
  memo = { at: Date.now(), value };
  return value;
}

/** What the catalog last reported, without booting a server (null before the
 *  first successful listing). Create-time validation reads this. */
export function knownOpencodeModels(): OpencodeCatalogModel[] | null { return last; }

/** Test seam. */
export function resetOpencodeModelsCache(): void { memo = null; last = null; }

/**
 * Resolve what the app sent as `model` to a {providerID, modelID} pair:
 * the curated pair by bare id (the old wire form), a catalog id
 * ("<providerID>/<modelID>") when the catalog is loaded, else the split at
 * the first "/" — providerIDs never contain one, model ids often do.
 * Returns null for a model the loaded catalog does not know.
 */
export function resolveOpencodeModel(spec: string | undefined): { providerID: string; modelID: string; variants: string[] } | null {
  if (!spec) { const d = defaultOpencodeModel(); return { providerID: d.providerID, modelID: d.id, variants: [] }; }
  const curated = OPENCODE_MODELS.find((m) => m.id === spec || `${m.providerID}/${m.id}` === spec);
  if (curated) {
    const live = last?.find((m) => m.providerID === curated.providerID && m.modelID === curated.id);
    return { providerID: curated.providerID, modelID: curated.id, variants: live?.variants ?? [] };
  }
  if (last) {
    const hit = last.find((m) => m.id === spec);
    return hit ? { providerID: hit.providerID, modelID: hit.modelID, variants: hit.variants } : null;
  }
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return null;
  return { providerID: spec.slice(0, slash), modelID: spec.slice(slash + 1), variants: [] };
}
