import { describe } from "vite-plus/test";

import { scaleHalves, scaleArmPart, scaleTimeout } from "./brain-scale-arm.ts";
import { mockIdp } from "./idp.ts";

// The Brain baseline at scale (GRA-678), the agent's first half: brain-scale.test.ts says
// what the run is, and brain-scale-arm.ts why each arm runs in parts.

const idp = mockIdp();

describe(
  "the Brain baseline at scale: the agent, part 1 of 2",
  { timeout: scaleTimeout },
  () => {
    scaleArmPart(idp, "agent", scaleHalves, 1, 0);
  }
);
