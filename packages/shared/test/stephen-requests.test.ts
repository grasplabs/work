import { describe, expect, it } from "vite-plus/test";

import {
  brainTool,
  monthSpan,
  requestsReport,
} from "../src/stephen-requests.ts";
import type { StephenRequest } from "../src/stephen-requests.ts";

const today = "2026-10-27";
const month = monthSpan(today);

/** One request of a person, done and answered from the brain unless said otherwise. */
const request = (
  day: string,
  personId: string,
  extra: Partial<StephenRequest> = {}
): StephenRequest => ({
  day,
  personId,
  outcome: "done",
  topic: "policies",
  question: null,
  tools: [{ id: brainTool, ok: true }],
  ...extra,
});

/** `n` people asking the same question, each once. */
const asked = (
  n: number,
  question: string,
  extra: Partial<StephenRequest> = {}
) =>
  Array.from({ length: n }, (_, index) =>
    request("2026-10-08", `${question}-${index}`, { question, ...extra })
  );

describe("Stephen's requests", () => {
  it("bill by the calendar month", () => {
    expect([
      month,
      monthSpan("2026-02-10"),
      monthSpan("2026-12-31"),
    ]).toStrictEqual([
      { from: "2026-10-01", to: "2026-10-31" },
      { from: "2026-02-01", to: "2026-02-28" },
      { from: "2026-12-01", to: "2026-12-31" },
    ]);
  });

  it("name what he didn't know only once five people asked it, never one person five times", () => {
    const report = requestsReport(
      [
        ...asked(6, "bonus", { outcome: "unanswered" }),
        ...asked(4, "rooms", { outcome: "unanswered" }),
        // Five people asked, but he answered.
        ...asked(5, "leave"),
        ...Array.from({ length: 5 }, () =>
          request("2026-10-08", "one", {
            question: "parking",
            outcome: "unanswered",
          })
        ),
        // Outside the span.
        ...asked(5, "september", { outcome: "unanswered" }).map((each) => ({
          ...each,
          day: "2026-09-30",
        })),
      ],
      month
    );
    expect(report.unanswered).toStrictEqual([
      { topic: "policies", question: "bonus", requests: 6, people: 6 },
    ]);
  });

  it("count the people a week, every week of the span, a quiet one as none", () => {
    const report = requestsReport(
      [
        request("2026-10-05", "a"),
        request("2026-10-06", "a"),
        request("2026-10-07", "b"),
        request("2026-10-20", "c"),
      ],
      { from: "2026-10-05", to: "2026-10-25" }
    );
    expect(report.weeks).toStrictEqual([
      { week: "2026-10-05", people: 2 },
      { week: "2026-10-12", people: 0 },
      { week: "2026-10-19", people: 1 },
    ]);
  });
});
