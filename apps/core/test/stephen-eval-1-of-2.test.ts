import { describe, expect, it } from "vite-plus/test";

import { stephenCases } from "./fixtures/stephen-cases.ts";
import { mockIdp } from "./idp.ts";
import {
  stephenCaseTests,
  stephenEvalRun,
  stephenEvalTimeout,
  stephenPart,
} from "./stephen-eval-parts.ts";

// Stephen's eval (GRA-720) as CI runs it: every case of the suite, through
// the real Workspace object, Knowledge, the agent's code, connect with
// Graph played by core's fake, the permissions, the model gateway and the
// ledger, with only the model provider stubbed (stephen-stub.ts). The stub
// answers as a careful Stephen would, and only from what reached it, so
// the run proves the platform gets each case's data to the model and holds
// every change for the person, and that the eval measures what it reports.
// The cases run in parts, a file each named for its part
// (stephen-eval-parts.ts): the first here, the second in
// stephen-eval-2-of-2.test.ts; and a case built to break each hard rule,
// which proves that rule would fail the run, in
// stephen-eval-breakers.test.ts, which also checks that the parts' files
// run every case. A real model's run, which costs money, is a separate
// opt-in (vite.stephen-model.config.ts).

const idp = mockIdp();

// The part of the cases this file's name says.
const { suite, cases } = stephenPart(import.meta.url);

describe("Stephen's eval", { timeout: stephenEvalTimeout }, () => {
  it("keeps a third of its cases in Dutch and a fifth typed messily", () => {
    const dutch = stephenCases.filter(({ lang }) => lang === "nl").length;
    const messy = stephenCases.filter(({ messy: typed }) => typed).length;
    expect({
      cases: stephenCases.length,
      unique: new Set(stephenCases.map(({ id }) => id)).size,
      dutch: dutch * 3 >= stephenCases.length,
      messy: messy * 5 >= stephenCases.length,
    }).toStrictEqual({ cases: 75, unique: 75, dutch: true, messy: true });
  });

  stephenCaseTests(suite, cases, stephenEvalRun(idp, suite, cases));
});
