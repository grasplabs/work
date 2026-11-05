/**
 * `#ultracite-rules` in Node, outside the compiler's bundle, which build.ts
 * writes it into: worked out as it is imported, from the same presets
 * (ultracite-rules.ts). It lets the repo's tests run Grasp's own lint and
 * format of App code (src/ultracite.ts) beside an exported App's.
 */
import { ultraciteRules } from "./ultracite-rules.ts";

export default ultraciteRules();
