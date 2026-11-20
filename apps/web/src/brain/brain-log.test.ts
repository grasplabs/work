import { describe, expect, it } from "vite-plus/test";

import { brainLog } from "./brain-log.ts";
import { buildBrain } from "./brain.ts";
import { testWorkspace } from "./test-workspace.ts";

// The brain's log, on the brain's test company: what came in and what
// Grasp asked, newest first, this week, last week and before; interviews
// only as a week's count.

describe(brainLog, () => {
  const ws = testWorkspace();
  const brain = buildBrain(ws);
  // A Wednesday: its week started on Monday 31 August.
  const log = brainLog(ws, brain, "2026-09-02");
  const entries = [...log.thisWeek, ...log.lastWeek, ...log.earlier];

  it("counts a week's interviews on its Monday, and never shows one conversation, its day or who gave it", () => {
    const conversations = new Set(
      ws.sources
        .filter(({ kind }) => kind === "interview" || kind === "chat")
        .map(({ id }) => id)
    );
    expect({
      weeks: entries
        .filter((entry) => entry.interviews !== undefined)
        .map(({ day, interviews, title, by }) => ({
          day,
          interviews,
          title,
          by,
        })),
      conversations: entries.filter(({ id }) => conversations.has(id)),
    }).toStrictEqual({
      weeks: [
        {
          day: "2026-08-31",
          interviews: { count: 12, week: 36 },
          title: "",
          by: undefined,
        },
        {
          day: "2026-08-24",
          interviews: { count: 9, week: 35 },
          title: "",
          by: undefined,
        },
      ],
      conversations: [],
    });
  });

  it("names an answered question by the role it was asked of, and keeps the days newest first", () => {
    const answered = entries.find(
      (entry) => entry.question?.step === "answered"
    );
    expect({
      by: answered?.by,
      newestFirst: entries
        .map(({ day }) => day)
        .every((day, index, days) => (days[index - 1] ?? day) >= day),
    }).toStrictEqual({
      by: "CFO",
      newestFirst: true,
    });
  });

  it("puts each line in its week: this week from Monday, last week, and before", () => {
    expect({
      thisWeek: log.thisWeek.every(({ day }) => day >= "2026-08-31"),
      lastWeek: log.lastWeek.every(
        ({ day }) => day >= "2026-08-24" && day < "2026-08-31"
      ),
      earlier: log.earlier.every(({ day }) => day < "2026-08-24"),
      weeks: [log.thisWeek, log.lastWeek].map(
        (stretch) =>
          stretch.find((entry) => entry.interviews !== undefined)?.interviews
      ),
    }).toStrictEqual({
      thisWeek: true,
      lastWeek: true,
      earlier: true,
      weeks: [
        { count: 12, week: 36 },
        { count: 9, week: 35 },
      ],
    });
  });
});
