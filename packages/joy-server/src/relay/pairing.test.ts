import { describe, it, expect } from "vitest";
import { parseBackupCode } from "./pairing";

// Mirror of the app's formatSecretKeyForBackup (secretKeyBackup.ts): base32,
// groups of 5, dash-joined. The parser must round-trip anything it emits.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function formatBackupCode(bytes: Uint8Array): string {
    let out = "", buf = 0, bits = 0;
    for (const b of bytes) {
        buf = (buf << 8) | b; bits += 8;
        while (bits >= 5) { bits -= 5; out += B32[(buf >> bits) & 0x1f]; }
    }
    if (bits > 0) out += B32[(buf << (5 - bits)) & 0x1f];
    const groups: string[] = [];
    for (let i = 0; i < out.length; i += 5) groups.push(out.slice(i, i + 5));
    return groups.join("-");
}

describe("parseBackupCode", () => {
    it("round-trips the app's dashed base32 format", () => {
        const secret = new Uint8Array(32).map((_, i) => (i * 37 + 5) & 0xff);
        expect(parseBackupCode(formatBackupCode(secret))).toEqual(secret);
    });

    it("forgives lowercase, spaces, and the app's typo substitutions (0→O, 1→I)", () => {
        const secret = new Uint8Array(32).map((_, i) => (i * 11 + 200) & 0xff);
        const code = formatBackupCode(secret).toLowerCase().replace(/-/g, " ").replace(/o/g, "0").replace(/i/g, "1");
        expect(parseBackupCode(code)).toEqual(secret);
    });

    it("accepts the bare base64url on-device form", () => {
        const secret = new Uint8Array(32).map((_, i) => i);
        expect(parseBackupCode(Buffer.from(secret).toString("base64url"))).toEqual(secret);
    });

    it("rejects wrong-length input", () => {
        expect(() => parseBackupCode("ABCDE-FGHIJ")).toThrow(/length/);
        expect(() => parseBackupCode("")).toThrow();
    });
});
