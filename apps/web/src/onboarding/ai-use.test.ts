import type { StaffAiUseRow } from "@grasp-os/shared/onboarding-staff";
import { describe, expect, it } from "vite-plus/test";

import { aiUseOf } from "./ai-use.ts";

const row = (
  day: string,
  purpose: StaffAiUseRow["purpose"],
  model: string,
  calls: number
): StaffAiUseRow => ({
  day,
  purpose,
  model,
  calls,
  tokensIn: calls * 100,
  tokensCached: calls * 10,
  tokensOut: calls,
  seconds: model === "voice" ? calls * 2 : 0,
});

describe("the onboarding's AI use in Grasp's area", () => {
  it("adds what core counted up in all, by purpose and its models, and by day", () => {
    const use = aiUseOf([
      row("2026-10-01", "interviews", "quick", 2),
      row("2026-10-01", "reading", "careful", 1),
      row("2026-10-02", "interviews", "careful", 3),
      row("2026-10-02", "interviews", "quick", 4),
      row("2026-10-02", "interviews", "voice", 5),
    ]);

    expect({
      total: use.total,
      purposes: use.purposes.map(({ purpose, used, models }) => [
        purpose,
        used.calls,
        models.map(({ model, used: each }) => [model, each.calls]),
      ]),
      days: use.days.map(({ day, used }) => [day, used.calls, used.seconds]),
    }).toStrictEqual({
      total: {
        calls: 15,
        tokensIn: 1500,
        tokensCached: 150,
        tokensOut: 15,
        seconds: 10,
      },
      purposes: [
        ["reading", 1, [["careful", 1]]],
        [
          "interviews",
          14,
          [
            ["quick", 6],
            ["voice", 5],
            ["careful", 3],
          ],
        ],
        ["drawing", 0, []],
      ],
      days: [
        ["2026-10-02", 12, 10],
        ["2026-10-01", 3, 0],
      ],
    });
  });
});
