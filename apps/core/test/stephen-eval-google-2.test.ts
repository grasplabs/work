import { describe } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import {
  stephenCaseTests,
  stephenEvalRun,
  stephenEvalTimeout,
  stephenHalves,
} from "./stephen-eval-parts.ts";

// Stephen's eval on Google Workspace (GRA-756), its second half of the
// cases: stephen-eval-google.test.ts says what the eval is, and
// stephen-eval-parts.ts why it runs in parts.

const idp = mockIdp();

const [, cases] = stephenHalves("google");

describe(
  "Stephen's eval on Google Workspace: the second half",
  { timeout: stephenEvalTimeout },
  () => {
    stephenCaseTests("google", cases, stephenEvalRun(idp, "google", cases));
  }
);
