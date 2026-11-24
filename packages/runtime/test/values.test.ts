import { isCronExpression } from "@grasp-os/shared/workflows";
import { describe, expect, test } from "vite-plus/test";

import {
  acceptedCrons,
  cronsNoParserAccepts,
  runValueCases,
} from "./value-cases.ts";

// The conformance cases of `v`, in workerd. The same cases run in a browser
// (e2e/sdk-values.e2e.ts); value-cases.ts says why.
describe("values", () => {
  test.each(runValueCases())("$name", ({ actual, expected }) => {
    expect(JSON.parse(actual)).toStrictEqual(JSON.parse(expected));
  });

  // `v.schedule()` has its own cron grammar, so the browser needs no parser;
  // it must stay inside what the parser schedules run on accepts.
  test.each(acceptedCrons)(
    "a cron expression a schedule value accepts is one schedules run on: %s",
    (cron) => {
      expect(isCronExpression(cron)).toBeTruthy();
    }
  );

  test.each(cronsNoParserAccepts)(
    "a cron expression schedules can't run on is refused as a value too: %s",
    (cron) => {
      expect(isCronExpression(cron)).toBeFalsy();
    }
  );
});
