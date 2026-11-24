import type { AiStatusReport } from "@grasp-os/shared/ai-status-report";
import { describe, expect, it } from "vite-plus/test";

import { graspAiLine } from "../src/admin/ai-status-words.ts";

/** A core's report with `graspAi` as given, and nothing else to say. */
const reportOf = (graspAi?: AiStatusReport["graspAi"]): AiStatusReport => ({
  providers: [],
  ...(graspAi === undefined ? {} : { graspAi }),
});

describe("a company's use of Grasp's AI, as its Setup says it", () => {
  it("says what the month came to against its limit, and that its AI is stopped once it reached it", () => {
    expect({
      under: graspAiLine(
        reportOf({
          spentMicros: 12_340_000,
          limitMicros: 100_000_000,
          reached: false,
        })
      ),
      reached: graspAiLine(
        reportOf({
          spentMicros: 100_020_000,
          limitMicros: 100_000_000,
          reached: true,
        })
      ),
    }).toStrictEqual({
      under: "On Grasp’s AI: $12.34 of $100.00 this month.",
      reached:
        "On Grasp’s AI: $100.02 this month, at its limit of $100.00. Its AI is stopped until next month, or until its admin connects a key of its own.",
    });
  });

  it("says nothing of a company on its own key, or one that couldn't be asked", () => {
    expect([graspAiLine(reportOf()), graspAiLine(null)]).toStrictEqual([
      null,
      null,
    ]);
  });
});
