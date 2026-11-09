import { describe, expect, it } from "vite-plus/test";

import {
  notOnGoogle,
  stephenCases,
  stephenCasesOn,
} from "./fixtures/stephen-cases.ts";
import { mockIdp } from "./idp.ts";
import {
  stephenCaseTests,
  stephenEvalRun,
  stephenEvalTimeout,
  stephenPart,
} from "./stephen-eval-parts.ts";

// Stephen's eval on Google Workspace (GRA-756), as CI runs it: the
// Microsoft 365 cases translated to Gmail, Google Calendar, a shared drive
// and the register in Google Sheets, through the same harness, connect
// with Google played by core's fake (stephen-google-fake.ts), the
// permissions, the model gateway and the ledger, with only the model
// provider stubbed, in parts, a file each named for its part
// (stephen-eval-parts.ts): the first here, the second in
// stephen-eval-google-2-of-2.test.ts. The cases that need a tool
// Google's connector lacks (moving an event, a reply draft, writing a
// sheet) are left out (`notOnGoogle`). A case built to break each hard
// rule proves the rule would fail the run, but one: no Google tool moves
// an event, so no turn can move a meeting of others there
// (`noMeetingOfOthersMoved`); they run in
// stephen-eval-google-breakers.test.ts, which also checks that the parts'
// files run every case.
//
// Under `gmail.modify`, which reading and labelling need, a grant can
// send: sending can't be split off by right, so Reach others holds by its
// class alone. stephen-eval-google-breakers.test.ts proves the class does:
// a turn that sends with the class off is refused before connect, though
// the grant could.

const idp = mockIdp();

// The part of the cases this file's name says.
const { suite, cases } = stephenPart(import.meta.url);

describe(
  "Stephen's eval on Google Workspace",
  { timeout: stephenEvalTimeout },
  () => {
    it("runs every Microsoft 365 case Google's tools can carry", () => {
      const onGoogle = stephenCasesOn("google");
      expect({
        cases: onGoogle.length,
        left: stephenCases
          .filter(({ id }) => !onGoogle.some((item) => item.id === id))
          .map(({ id }) => id),
      }).toStrictEqual({
        cases: stephenCases.length - Object.keys(notOnGoogle).length,
        left: Object.keys(notOnGoogle),
      });
    });

    stephenCaseTests(suite, cases, stephenEvalRun(idp, suite, cases));
  }
);
