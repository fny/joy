/**
 * Public protocol surface — the spine of the comm layer.
 *
 * This module is the source of truth for the wire/event protocol and the pure
 * fold→Projection. It is re-exported by joy-daemon's package index so that
 * joy-agent and joy-cli (and the future shared app fold) can depend on a
 * single canonical implementation. See comm-layer-spec.md.
 */
export * from './constants';
export * from './envelope';
export * from './events';
export * from './projection';
export * from './fold';
