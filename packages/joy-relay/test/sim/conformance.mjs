// The contract each endpoint keeps: which answers it may give. A status or
// error code outside the set is spec drift — the relay answering something
// no client was written to handle — and the run stops on it like on any
// other violation. The sets come from core.mjs / v2.mjs; when the relay
// legitimately grows an answer, it is added here on purpose.
const ok = (...codes) => new Set(codes);

export const CONTRACT = [
  // daemon lane
  [/^POST \/joy\/v2\/daemon\/leases$/, { 200: ok(), 403: ok('daemon_owned_by_other_account'), 429: ok('too_many_daemons') }],
  [/^PUT \/joy\/v2\/daemon\/leases\/[\w-]+$/, { 200: ok(), 401: ok('lease_unknown', 'missing_lease_token'), 412: ok('lease_expired') }],
  [/^POST \/joy\/v2\/daemon\/leases\/[\w-]+\/claims\/(work|control)$/, { 200: ok(), 401: ok('lease_unknown', 'missing_lease_token'), 412: ok('lease_expired', 'lease_epoch_stale') }],
  [/^POST \/joy\/v2\/daemon\/deliveries\/[\w-]+\/received$/, { 200: ok(), 401: ok('lease_unknown'), 404: ok('delivery_not_found'), 409: ok('delivery_superseded'), 412: ok('lease_expired', 'lease_epoch_stale') }],
  [/^POST \/joy\/v2\/daemon\/sessions\/[\w-]+\/bind$/, { 200: ok(), 400: ok('missing_spawnCommandId'), 401: ok('lease_unknown'), 403: ok('not_owner_daemon'), 404: ok('session_not_found', 'spawn_command_not_found'), 409: ok('already_bound', 'spawn_cancelled'), 412: ok('lease_expired', 'lease_epoch_stale') }],
  [/^PATCH \/joy\/v2\/daemon\/sessions\/[\w-]+$/, { 200: ok(), 401: ok('lease_unknown'), 403: ok('not_owner_daemon'), 404: ok('session_not_found'), 412: ok('lease_expired', 'lease_epoch_stale') }],
  [/^POST \/joy\/v2\/daemon\/sessions\/[\w-]+\/spawn-failed$/, { 200: ok(), 401: ok('lease_unknown'), 403: ok('not_owner_daemon'), 404: ok('session_not_found'), 412: ok('lease_expired', 'lease_epoch_stale') }],
  [/^POST \/joy\/v2\/daemon\/turns\/[\w-]+\/submitted$/, { 200: ok(), 401: ok('lease_unknown'), 403: ok('not_owner_daemon'), 404: ok('turn_not_found'), 409: ok('turn_terminal', 'session_archived', 'session_failed', 'no_current_delivery'), 412: ok('lease_expired', 'lease_epoch_stale') }],
  [/^POST \/joy\/v2\/daemon\/turns\/[\w-]+\/start$/, { 200: ok(), 401: ok('lease_unknown'), 403: ok('not_owner_daemon'), 404: ok('turn_not_found'), 409: ok('turn_cancelled', 'turn_terminal', 'turn_orphaned_reconcile_first', 'session_archived', 'session_failed', 'another_turn_active', 'no_current_delivery', 'not_queue_head', 'session_event_budget_exhausted'), 412: ok('lease_expired', 'lease_epoch_stale') }],
  [/^POST \/joy\/v2\/daemon\/turns\/[\w-]+\/facts$/, { 200: ok(), 400: ok('bad_terminal_state', 'bad_fact_type'), 401: ok('lease_unknown'), 403: ok('not_owner_daemon'), 404: ok('turn_not_found'), 409: ok('turn_terminal'), 412: ok('lease_expired', 'lease_epoch_stale'), 413: ok('ciphertext_too_large'), 429: ok('session_event_budget_exhausted') }],
  [/^POST \/joy\/v2\/daemon\/turns\/[\w-]+\/reconcile$/, { 200: ok(), 400: ok('bad_resolution', 'bad_terminal_state'), 401: ok('lease_unknown'), 403: ok('not_owner_daemon'), 404: ok('turn_not_found'), 409: ok('turn_not_orphaned', 'another_turn_active', 'session_archived', 'session_failed', 'session_event_budget_exhausted'), 412: ok('lease_expired', 'lease_epoch_stale') }],
  // app
  [/^POST \/joy\/v2\/sessions$/, { 200: ok(), 409: ok('daemon_unknown', 'idempotency_mismatch'), 403: ok('daemon_owned_by_other_account'), 429: ok('too_many_sessions') }],
  [/^GET \/joy\/v2\/sessions\/[\w-]+$/, { 200: ok(), 404: ok('session_not_found') }],
  [/^GET \/joy\/v2\/sessions\/[\w-]+\/messages(\?.*)?$/, { 200: ok(), 404: ok('session_not_found') }],
  [/^POST \/joy\/v2\/sessions\/[\w-]+\/messages$/, { 202: ok(), 404: ok('session_not_found'), 409: ok('session_not_ready', 'idempotency_mismatch'), 413: ok('ciphertext_too_large'), 429: ok('queue_full', 'session_event_budget_exhausted') }],
  [/^PATCH \/joy\/v2\/sessions\/[\w-]+\/messages\/[\w-]+$/, { 200: ok(), 400: ok('bad_position'), 404: ok('session_not_found', 'message_not_found'), 409: ok('not_editable') }],
  [/^DELETE \/joy\/v2\/sessions\/[\w-]+\/messages\/[\w-]+$/, { 200: ok(), 404: ok('session_not_found', 'message_not_found', 'turn_not_found'), 409: ok('not_deletable') }],
  [/^POST \/joy\/v2\/sessions\/[\w-]+\/messages\/[\w-]+\/retry$/, { 202: ok(), 404: ok('session_not_found', 'message_not_found'), 409: ok('not_retryable', 'cancellation_pending') }],
  [/^POST \/joy\/v2\/sessions\/[\w-]+\/turns\/[\w-]+\/cancellations$/, { 200: ok(), 404: ok('session_not_found', 'turn_not_found'), 409: ok('different_turn_active', 'idempotency_mismatch') }],
  [/^POST \/joy\/v2\/sessions\/[\w-]+\/spawn\/retry$/, { 200: ok(), 404: ok('session_not_found', 'spawn_command_not_found'), 409: ok('not_retryable', 'already_bound') }],
];

export class ContractViolation extends Error {
  constructor(entry, why) {
    super(`contract violation: ${entry.method} ${entry.path} answered ${entry.status} ${JSON.stringify(entry.json)?.slice(0, 200)} — ${why}`);
    this.entry = entry;
  }
}

/** Check one trace entry against the contract; throw if it is outside it. */
export function checkContract(entry) {
  if (entry.status === undefined) return; // transport failure: handled by the caller
  const key = `${entry.method} ${entry.path}`;
  const hit = CONTRACT.find(([re]) => re.test(key));
  if (!hit) throw new ContractViolation(entry, 'no contract entry for this endpoint');
  const allowed = hit[1][entry.status];
  if (!allowed) throw new ContractViolation(entry, `status ${entry.status} not in contract (${Object.keys(hit[1]).join(', ')})`);
  if (entry.status >= 400) {
    const code = typeof entry.json?.error === 'string' ? entry.json.error : entry.json?.error?.error;
    if (!allowed.has(code)) throw new ContractViolation(entry, `error code ${code} not in contract for ${entry.status} (${[...allowed].join(', ')})`);
  }
}
