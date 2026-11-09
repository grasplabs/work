import { describe } from "vite-plus/test";

import { baselinePartTests, baselineTimeout } from "./brain-baseline-parts.ts";
import { mockIdp } from "./idp.ts";

// The Brain baseline's part 3 of 4: brain-baseline-parts.ts says what
// each part holds and why the baseline runs in parts.

const idp = mockIdp();

describe("the Brain baseline: part 3", { timeout: baselineTimeout }, () => {
  baselinePartTests(idp, 3);
});
