// In-process wake-ups. Correctness never depends on these: claims re-query
// the database on connect, and SSE pokes carry no content — a missed wake
// costs one long-poll timeout (~25s), never a lost command.

/** Bytes Node may hold for one SSE client before the relay gives up on it
 *  (#81). A client that reads slower than a session emits used to grow an
 *  unbounded kernel-side backlog inside the relay process. */
export const SSE_MAX_BUFFERED_BYTES = 1024 * 1024;
/** Frames parked for a client whose hello snapshot is still being built. */
const SSE_PREREADY_MAX_FRAMES = 512;

export function createNotify() {
  const daemonWaiters = new Map();   // `${daemonId}:${lane}` -> Set<fn>
  const sseClients = new Map();      // accountId -> Set<client>

  /** One frame to one client under the backpressure policy (#81):
   *  - a replaceable delta (`droppable`) is skipped while the socket waits
   *    for drain — the durable block that follows supersedes it anyway;
   *  - a poke is tiny and must arrive, but not at any cost: past the byte
   *    cap the client is stalled and closing it is the honest outcome — its
   *    reconnect re-syncs from the hello snapshot, so a dropped poke costs
   *    one refetch, never a lost event. */
  function send(client, frame, { droppable = false } = {}) {
    const res = client.res;
    if (res.destroyed || res.writableEnded) return false;
    if (droppable && res.writableNeedDrain) { client.dropped++; return false; }
    if ((res.writableLength ?? 0) + frame.length > SSE_MAX_BUFFERED_BYTES) {
      client.stalled = true;
      try { res.destroy(); } catch { /* already gone */ }
      return false;
    }
    try { res.write(frame); return true; } catch { return false; }
  }

  function fanOut(accountId, frame, opts) {
    const set = sseClients.get(accountId);
    if (!set) return;
    for (const client of set) {
      if (!client.ready) {
        if (opts?.droppable && client.buf.length >= SSE_PREREADY_MAX_FRAMES) { client.dropped++; continue; }
        client.buf.push([frame, opts]);
        continue;
      }
      send(client, frame, opts);
    }
  }

  return {
    /** Park until woken or timeout. Caller re-queries either way. */
    waitForDaemon(daemonId, lane, timeoutMs) {
      const key = `${daemonId}:${lane}`;
      return new Promise((resolve) => {
        const set = daemonWaiters.get(key) ?? new Set();
        daemonWaiters.set(key, set);
        let done = false;
        const fire = () => {
          if (done) return;
          done = true;
          set.delete(fire);
          // The last waiter takes the key with it (#618): every daemon id
          // that ever polled otherwise kept an empty Set in this map for
          // the life of the process.
          if (set.size === 0 && daemonWaiters.get(key) === set) daemonWaiters.delete(key);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(fire, timeoutMs);
        set.add(fire);
      });
    },

    wakeDaemon(daemonId, lane) {
      const set = daemonWaiters.get(`${daemonId}:${lane}`);
      if (!set) return;
      for (const fire of [...set]) fire();
    },

    /** Register BEFORE computing the hello snapshot; pokes committed while
     *  the snapshot is being built buffer until markReady() flushes them —
     *  the client misses nothing (lost-wake safety for SSE). Returns null
     *  when the account is at its connection cap. */
    addSse(accountId, res, maxPerAccount = 8) {
      const set = sseClients.get(accountId) ?? new Set();
      if (set.size >= maxPerAccount) return null;
      sseClients.set(accountId, set);
      const client = { res, ready: false, buf: [], dropped: 0, stalled: false };
      set.add(client);
      res.on('close', () => {
        set.delete(client);
        if (set.size === 0) sseClients.delete(accountId);
      });
      return {
        markReady() {
          client.ready = true;
          for (const [frame, opts] of client.buf.splice(0)) send(client, frame, opts);
        },
      };
    },

    /** v2 streaming lane: content-bearing SSE frame, never persisted.
     *  Loss is harmless BY CONSTRUCTION — the durable block that follows
     *  supersedes every delta. */
    emitEphemeral(accountId, sessionId, turnId, ciphertext) {
      const frame = `event: ephemeral
data: ${JSON.stringify({ v: 1, sessionId, turnId, ciphertext })}

`;
      fanOut(accountId, frame, { droppable: true });
    },

    pokeAccount(accountId, sessionId, changed) {
      const frame = `event: poke\ndata: ${JSON.stringify({ v: 1, sessionId, changed })}\n\n`;
      fanOut(accountId, frame, { droppable: false });
    },

    /** Test/ops visibility only — counts, never contents. */
    stats() {
      let sseClientCount = 0;
      for (const set of sseClients.values()) sseClientCount += set.size;
      return { daemonWaiterKeys: daemonWaiters.size, sseAccounts: sseClients.size, sseClients: sseClientCount };
    },
  };
}
