// English lives in ../_default.ts (the runtime source of truth); this
// module only re-exports it so the compare script and the language table
// can import every language from one directory.
export { en } from '../_default';
