/**
 * Prints the key core's global setup keeps its builds under
 * (prebuilt.ts), for CI to cache `apps/core/dist/test-prebuilt` by:
 * `node apps/core/test/prebuilt-key.ts`.
 */
import { prebuiltKey } from "./prebuilt.ts";

process.stdout.write(`${prebuiltKey() ?? "none"}\n`);
