import { describe } from "vite-plus/test";

import { scaleHalves, scaleArmPart, scaleTimeout } from "./brain-scale-arm.ts";
import { mockIdp } from "./idp.ts";

// The Brain baseline at scale (GRA-678), full text's second half: brain-scale.test.ts says
// what the run is, and brain-scale-arm.ts why each arm runs in parts.

const idp = mockIdp();

describe(
  "the Brain baseline at scale: full text, part 2 of 2",
  { timeout: scaleTimeout },
  () => {
    scaleArmPart(idp, "fullText", scaleHalves, 2, 0);
  }
);
