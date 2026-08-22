// The e2e test imports the sibling joy-relay package's untyped .mjs modules
// (real relay in the loop, by design). Blanket-declare them; the daemon's own
// TS modules are unaffected.
declare module "*.mjs";
