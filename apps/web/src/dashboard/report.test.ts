import type { RunActivity } from "@grasp-os/shared/workflows";
import { i18n } from "@lingui/core";
import { describe, expect, it } from "vite-plus/test";

import { reportFigures } from "./report.ts";

// The report's key figures (report.ts), which its PDF and its dialog show
// as tiles: what ran in the window, and how much of it no one touched.

/** Core's run activity over two days, with `total` runs of which `alone` asked no one. */
const activity = (total: number, alone: number): RunActivity => ({
  from: "2026-10-22",
  to: "2026-10-28",
  days: [
    {
      day: "2026-10-27",
      completed: 3,
      failed: 1,
      waiting: 0,
      other: 0,
      withPerson: 1,
    },
    {
      day: "2026-10-28",
      completed: 4,
      failed: 0,
      waiting: 2,
      other: 0,
      withPerson: 1,
    },
  ],
  runs: { total, withPerson: total - alone, withoutPerson: alone },
  decisions: { approved: 0, rejected: 0, timedOut: 0, open: 0 },
  workflows: [],
});

describe("the report's figures", () => {
  it("are the runs started, completed and failed, and the share that ran without a person", () => {
    const figures = reportFigures(
      { state: "ready", data: activity(10, 8) },
      i18n
    );
    expect(
      figures.map(({ label, value }) => `${label}: ${value}`)
    ).toStrictEqual([
      "Runs started: 10",
      "Completed: 7",
      "Failed: 1",
      "Ran without a person: 80%",
    ]);
  });

  it("are written as the reader's language writes numbers", () => {
    i18n.loadAndActivate({ locale: "de", messages: {} });
    try {
      const figures = reportFigures(
        { state: "ready", data: activity(1200, 600) },
        i18n
      );
      expect(figures[0]?.value).toBe("1.200");
      expect(figures[3]?.value).toMatch(/^50\s%$/u);
    } finally {
      i18n.loadAndActivate({ locale: "en", messages: {} });
    }
  });

  it("are none when nothing ran, or the runs couldn't be read", () => {
    expect(
      reportFigures({ state: "ready", data: activity(0, 0) }, i18n)
    ).toStrictEqual([]);
    expect(reportFigures({ state: "offline" }, i18n)).toStrictEqual([]);
  });
});
