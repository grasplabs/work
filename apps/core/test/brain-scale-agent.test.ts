import { describe } from "vite-plus/test";

import {
  brainScaleRun,
  scaleArmTests,
  scaleTimeout,
} from "./brain-scale-arm.ts";
import { mockIdp } from "./idp.ts";

// The Brain baseline at scale (GRA-678), the agent's arm: brain-scale.test.ts
// says what the run is, and brain-scale-arm.ts why each arm has a file.

const idp = mockIdp();

describe(
  "the Brain baseline at scale: the agent",
  { timeout: scaleTimeout },
  () => {
    scaleArmTests("agent", brainScaleRun(idp, "agent"), 0);
  }
);
