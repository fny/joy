// Who a queued message came from, read off the wrapper the daemon itself
// wrote at accept (`<joy-message from="joy:1a2b3c4d" from-label="…">`).
// The app keeps these rows out of the user's own queue: a burst of `joy send`
// from other agents used to litter the visible queue as if the user had
// typed them (2026-09-11).
export interface PeerOrigin { from?: string; fromLabel?: string }

const HEAD = /^<joy-message\b([^>]*)>/i;
const ATTR = (name: string, attrs: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];

export function peerOf(text: string): PeerOrigin {
  const m = HEAD.exec(text.trimStart());
  if (!m) return {};
  const from = ATTR("from", m[1]);
  if (!from) return {};
  const fromLabel = ATTR("from-label", m[1]);
  return { from, ...(fromLabel ? { fromLabel } : {}) };
}
