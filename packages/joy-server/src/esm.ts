import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// ESM equivalent of __dirname for the calling module: pass import.meta.url.
// Replaces Bun's import.meta.dir, which doesn't exist under Node.
export function moduleDir(metaUrl: string): string {
  return dirname(fileURLToPath(metaUrl));
}
