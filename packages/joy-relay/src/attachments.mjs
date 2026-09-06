// v2 attachments: device-born sealed content (pasted screenshots, drawings)
// that must reach every device and the agent with the machine dead. The relay
// stores ciphertext it cannot read. Machine-born files are NEVER stored here —
// they are live tunnel reads; the two never overlap.
import { randomUUID, createHash } from 'node:crypto';
import { ApiError } from './core.mjs';

export const ATTACHMENT_MAX = 32 * 1024 * 1024;
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;

export function createAttachments(db) {
  return {
    /** Store sealed bytes. Dedupe per (session, hash) — a retried upload gets
     *  the same id back. The hash the client declares must match the bytes. */
    async store(accountId, sessionId, declaredHash, body) {
      if (body.length === 0) throw new ApiError(400, 'empty_body');
      if (body.length > ATTACHMENT_MAX) throw new ApiError(413, 'body_too_large');
      const hash = createHash('sha256').update(body).digest('hex');
      if (declaredHash && declaredHash !== hash) throw new ApiError(400, 'hash_mismatch');
      return db.tx(async (t) => {
        const { rows: [sess] } = await t.query(
          `SELECT account_id FROM native_sessions WHERE id = $1`, [sessionId]);
        if (!sess) throw new ApiError(404, 'session_not_found');
        if (sess.account_id !== accountId) throw new ApiError(403, 'not_your_session');
        const { rows: [dup] } = await t.query(
          `SELECT id, size FROM attachments WHERE session_id = $1 AND cipher_hash = $2`, [sessionId, hash]);
        if (dup) {
          // The client is about to cite this id in a message. Renew the orphan
          // clock INSIDE the upload transaction: an unreferenced duplicate older
          // than the TTL was otherwise acknowledged and then swept before the
          // message that cites it could commit (#611).
          await t.query(`UPDATE attachments SET uploaded_at = now() WHERE id = $1`, [dup.id]);
          return { attachmentId: dup.id, size: dup.size, deduped: true };
        }
        const id = randomUUID();
        await t.query(
          `INSERT INTO attachments (id, session_id, account_id, cipher_hash, size, body)
           VALUES ($1,$2,$3,$4,$5,$6)`, [id, sessionId, accountId, hash, body.length, body]);
        return { attachmentId: id, size: body.length, deduped: false };
      });
    },

    async fetch(accountId, attachmentId) {
      const { rows: [row] } = await db.query(
        `SELECT account_id, body FROM attachments WHERE id = $1`, [attachmentId]);
      if (!row || row.account_id !== accountId) throw new ApiError(404, 'not_found');
      return Buffer.from(row.body);
    },

    /** Called by POST /messages BEFORE acceptance: every id must exist and
     *  belong to the session, and each gets a reference row under the intent
     *  marker in the SAME transaction — from this instant the orphan sweep
     *  cannot touch it, so acceptance can never land on a swept attachment.
     *  References are a JOIN TABLE (#58): a blob cited by two prompts holds
     *  one row per prompt, so every offer finds its own authorization. */
    async reference(t, sessionId, marker, ids) {
      for (const id of ids) {
        const { rows: [row] } = await t.query(
          `SELECT id FROM attachments WHERE id = $1 AND session_id = $2`, [id, sessionId]);
        if (!row) throw new ApiError(422, 'unknown_attachment');
        await t.query(`INSERT INTO attachment_refs (attachment_id, ref) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [id, marker]);
      }
    },

    /** After acceptance: upgrade this message's intent rows to the real
     *  messageId. Rows held by earlier messages are untouched. */
    async claim(t, ids, marker, messageId) {
      for (const id of ids) {
        await t.query(`UPDATE attachment_refs SET ref = $1 WHERE attachment_id = $2 AND ref = $3`,
          [messageId, id, marker]);
      }
    },

    /** The attachments a given message (command) may cite — what the work
     *  offer carries so the daemon can fetch device-born content. */
    async forMessage(t, messageId) {
      const { rows } = await t.query(
        `SELECT a.id, a.size FROM attachment_refs r JOIN attachments a ON a.id = r.attachment_id
         WHERE r.ref = $1 ORDER BY a.created_at`, [messageId]);
      return rows.map((a) => ({ id: a.id, size: a.size }));
    },

    /** Session purge cascade (refs cascade from the blob rows). */
    async purgeSession(t, sessionId) {
      await t.query(`DELETE FROM attachments WHERE session_id = $1`, [sessionId]);
    },

    /** Blobs with no real reference whose LAST upload is older than the TTL.
     *  Stale intent rows (acceptance failed after the mark) age out first so
     *  they cannot pin a blob forever; the pin holds while ANY message cites
     *  the blob (#58). */
    async sweepOrphans(now = Date.now()) {
      const cutoff = new Date(now - ORPHAN_TTL_MS).toISOString();
      return db.tx(async (t) => {
        await t.query(`DELETE FROM attachment_refs WHERE ref LIKE 'intent:%' AND created_at < $1`, [cutoff]);
        const { rows } = await t.query(
          `DELETE FROM attachments a
           WHERE a.uploaded_at < $1
             AND NOT EXISTS (SELECT 1 FROM attachment_refs r WHERE r.attachment_id = a.id)
           RETURNING id`, [cutoff]);
        return rows.length;
      });
    },
  };
}
