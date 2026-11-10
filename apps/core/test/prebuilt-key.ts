/**
 * Prints the key core's global setup keeps its builds under
 * (prebuilt.ts), which CI restores `apps/core/dist/test-prebuilt` by
 * (ci.yml):
 * `node apps/core/test/prebuilt-key.ts`.
 */
import { prebuiltKey } from "./prebuilt.ts";

process.stdout.write(`${prebuiltKey() ?? "none"}\n`);
