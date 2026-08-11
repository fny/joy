// In-process wake-ups. Correctness never depends on these: claims re-query
// the database on connect, and SSE pokes carry no content — a missed wake
// costs one long-poll timeout (~25s), never a lost command.
export function createNotify() {
  const daemonWaiters = new Map();   // `${daemonId}:${lane}` -> Set<fn>
  const sseClients = new Map();      // accountId -> Set<res>

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
      const client = { res, ready: false, buf: [] };
      set.add(client);
      res.on('close', () => {
        set.delete(client);
        if (set.size === 0) sseClients.delete(accountId);
      });
      return {
        markReady() {
          client.ready = true;
          for (const frame of client.buf.splice(0)) {
            try { res.write(frame); } catch { /* dead socket */ }
          }
        },
      };
    },

    pokeAccount(accountId, sessionId, changed) {
      const set = sseClients.get(accountId);
      if (!set) return;
      const frame = `event: poke\ndata: ${JSON.stringify({ v: 1, sessionId, changed })}\n\n`;
      for (const client of set) {
        if (!client.ready) { client.buf.push(frame); continue; }
        try { client.res.write(frame); } catch { /* dead socket; close handler cleans up */ }
      }
    },
  };
}
