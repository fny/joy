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

// #607: a poll that finds the answer already collected is answered
// `{state:'consumed', error, consumedAt, message}` — pairWithRelay must
// surface the relay's words and the moment, not "not authorized".
import * as http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairWithRelay } from "./pairing";

describe("pairWithRelay: consumed answer (#607)", () => {
    it("throws the relay's message and the consumedAt instant", async () => {
        const consumedAt = Date.UTC(2026, 8, 6, 12, 34, 56);
        let polls = 0;
        const server = http.createServer((req, res) => {
            let raw = ""; req.on("data", (c) => (raw += c));
            req.on("end", () => {
                const send = (o: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
                if (req.url === "/joy/v2/auth") return send({ token: "acct" });
                if (req.url === "/joy/v2/auth/response") return send({ success: true });
                if (req.url === "/joy/v2/auth/request") {
                    polls++;
                    if (polls === 1) return send({ state: "requested" });
                    return send({
                        state: "consumed", error: "pairing_answer_already_collected", consumedAt,
                        message: "This pairing answer was already collected — it cannot be re-issued; start a new pairing.",
                    });
                }
                res.writeHead(404); res.end();
            });
        });
        const url = await new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as any).port}`)));
        try {
            const creds = mkdtempSync(join(tmpdir(), "joy-pair-test-"));
            await expect(pairWithRelay(url, new Uint8Array(32).fill(3), creds)).rejects.toThrow(
                /already collected — it cannot be re-issued; start a new pairing\. \(collected at 2026-09-06T12:34:56\.000Z\)/,
            );
            expect(polls).toBe(2);
        } finally { server.close(); }
    });
});
