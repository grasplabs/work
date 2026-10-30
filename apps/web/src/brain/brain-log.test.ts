import { describe, expect, it } from "vite-plus/test";

import { brainLog, logColumns } from "./brain-log.ts";
import { buildBrain } from "./brain.ts";
import { testWorkspace } from "./test-workspace.ts";

// The brain's log, on the brain's test company: what came in and what
// Grasp asked, day by day; interviews only as a week's count.

describe(brainLog, () => {
  const ws = testWorkspace();
  const brain = buildBrain(ws);
  const all = brainLog(ws, brain);
  const entries = all.flatMap((day) => day.entries);

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
      newestFirst: all
        .map(({ day }) => day)
        .every((day, index, days) => (days[index - 1] ?? day) >= day),
      documentsOnly: brainLog(ws, brain, "reading")
        .flatMap((day) => day.entries)
        .every(({ kind }) => kind === "reading"),
    }).toStrictEqual({
      by: "CFO",
      newestFirst: true,
      documentsOnly: true,
    });
  });

  it("draws every day up to today as a column, a dot for each interview of a week", () => {
    const columns = logColumns(all, "2026-10-29");
    const monday = columns.find(({ day }) => day === "2026-08-31");
    expect({
      last: columns.at(-1)?.day,
      first: columns[0]?.day,
    }).toStrictEqual({ last: "2026-10-29", first: all.at(-1)?.day });
    // The week's twelve interviews, and whatever else came in that Monday.
    expect(monday?.dots.length ?? 0).toBeGreaterThanOrEqual(12);
  });
});
