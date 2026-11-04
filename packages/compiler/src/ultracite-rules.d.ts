// Ultracite's rules as the compiler lints App code with them, worked out
// by build.ts (ultracite-rules.ts) into the compiler's bundle.
import type { UltraciteRules } from "../ultracite-rules.ts";

declare const rules: UltraciteRules;
export default rules;
