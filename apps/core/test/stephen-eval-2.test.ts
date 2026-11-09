import { describe } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import {
  stephenCaseTests,
  stephenEvalRun,
  stephenEvalTimeout,
  stephenHalves,
} from "./stephen-eval-parts.ts";

// Stephen's eval (GRA-720), its second half of the cases:
// stephen-eval.test.ts says what the eval is, and stephen-eval-parts.ts
// why it runs in parts.

const idp = mockIdp();

const [, cases] = stephenHalves("microsoft");

describe(
  "Stephen's eval: the second half",
  { timeout: stephenEvalTimeout },
  () => {
    stephenCaseTests(
      "microsoft",
      cases,
      stephenEvalRun(idp, "microsoft", cases)
    );
  }
);
