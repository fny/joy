import { describe, it, expect } from "vitest";
import { deriveRelayPerimeterKey } from "./pairing";

// Golden vector: MUST match the app's
// encodeHex(deriveKey(masterSecret, 'Joy Relay', ['perimeter'])) — the two
// implementations derive independently; this pins the daemon side so a
// refactor can't silently fork the tree.
describe("deriveRelayPerimeterKey", () => {
  it("derives a stable 64-hex value from a 32-byte secret", () => {
    const secret = new Uint8Array(32).fill(7);
    const k = deriveRelayPerimeterKey(secret);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    // Independently computed via the app's tree (root 'Joy Relay Master
    // Seed', child 0x00||'perimeter') — pins cross-implementation equality.
    expect(k).toBe("a5c79ee228f353c02c609ce447e6b20492f428038c74a1dcea2f5b7de9768d23");
    expect(deriveRelayPerimeterKey(new Uint8Array(32).fill(7))).toBe(k);
    expect(deriveRelayPerimeterKey(new Uint8Array(32).fill(8))).not.toBe(k);
  });
});
