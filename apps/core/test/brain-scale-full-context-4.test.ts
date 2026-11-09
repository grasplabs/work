import { describe } from "vite-plus/test";

import {
  scaleQuarters,
  scaleArmPart,
  scaleTimeout,
} from "./brain-scale-arm.ts";
import { mockIdp } from "./idp.ts";

// The Brain baseline at scale (GRA-678), full context's part 4 of 4, in
// which every person reads more than the budget holds already:
// brain-scale.test.ts says what the run is, and brain-scale-arm.ts why
// each arm runs in parts.

const idp = mockIdp();

describe(
  "the Brain baseline at scale: full context, part 4 of 4",
  { timeout: scaleTimeout },
  () => {
    scaleArmPart(idp, "fullContext", scaleQuarters, 4, 1);
  }
);
