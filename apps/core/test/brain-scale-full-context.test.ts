import { describe } from "vite-plus/test";

import {
  brainScaleRun,
  scaleArmTests,
  scaleTimeout,
} from "./brain-scale-arm.ts";
import { mockIdp } from "./idp.ts";

// The Brain baseline at scale (GRA-678), full context's arm:
// brain-scale.test.ts says what the run is, and brain-scale-arm.ts why
// each arm has a file.

const idp = mockIdp();

describe(
  "the Brain baseline at scale: full context",
  { timeout: scaleTimeout },
  () => {
    // Every person reads more than the budget holds at this size already.
    scaleArmTests("fullContext", brainScaleRun(idp, "fullContext"), 1);
  }
);
