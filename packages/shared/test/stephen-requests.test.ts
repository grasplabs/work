import { describe, expect, it } from "vite-plus/test";

import {
  brainTool,
  defaultMinutesSaved,
  elsewhere,
  fewestPeople,
  growth,
  lastWeeks,
  minutesSaved,
  paceToEnd,
  quietTeams,
  rangeSpan,
  requestsReport,
  runningTotal,
  spanBefore,
} from "../src/stephen-requests.ts";
import type { StephenRequest } from "../src/stephen-requests.ts";

const today = "2026-10-27";
const month = rangeSpan("month", today);
const noReach = new Map<string, number>();

let made = 0;

/** One request of a person, done and answered from the brain unless said otherwise. */
const request = (
  day: string,
  personId: string,
  teamId: string,
  extra: Partial<StephenRequest> = {}
): StephenRequest => {
  made += 1;
  return {
    id: `teams:${made}`,
    day,
    place: "teams",
    personId,
    teamId,
    kind: "answered",
    outcome: "done",
    topic: "policies",
    question: null,
    tools: [{ id: brainTool, ok: true }],
    missing: [],
    rating: null,
    ...extra,
  };
};

/** Requests of one question by `n` different people, each rating his reply the same way. */
const rated = (n: number, question: string, rating: "up" | "down") =>
  Array.from({ length: n }, (_, index) =>
    request("2026-10-08", `${question}-${rating}-${index}`, "t", {
      question,
      rating,
    })
  );

/** `n` people asking the same question, each once. */
const asked = (
  n: number,
  question: string,
  extra: Partial<StephenRequest> = {}
) =>
  Array.from({ length: n }, (_, index) =>
    request("2026-10-08", `${question}-${index}`, "t", { question, ...extra })
  );

/** A month of requests: every weekday, `perDay` people each ask once. */
const steady = (perDay: number) => {
  const all: StephenRequest[] = [];
  for (let day = 1; day <= 27; day += 1) {
    const at = `2026-10-${String(day).padStart(2, "0")}`;
    for (let index = 0; index < perDay; index += 1) {
      all.push(request(at, `p${index}`, "t"));
    }
  }
  return all;
};

describe("Stephen's requests", () => {
  it("cover whole calendar months: the month so far, the one before, and twelve up to this one", () => {
    expect(rangeSpan("month", today)).toStrictEqual({
      from: "2026-10-01",
      to: "2026-10-31",
      by: "day",
    });
    expect(rangeSpan("lastMonth", today)).toStrictEqual({
      from: "2026-09-01",
      to: "2026-09-30",
      by: "day",
    });
    expect(rangeSpan("year", today)).toStrictEqual({
      from: "2025-11-01",
      to: "2026-10-31",
      by: "month",
    });
    expect(rangeSpan("lastMonth", "2027-01-15")).toStrictEqual({
      from: "2026-12-01",
      to: "2026-12-31",
      by: "day",
    });
  });

  it("bill finished work only, say why the rest was not, and keep a bar for every day of the month", () => {
    const report = requestsReport(
      [
        request("2026-10-02", "a", "t"),
        request("2026-10-02", "a", "t", { kind: "lookedUp" }),
        request("2026-10-05", "b", "t", { outcome: "unanswered" }),
        request("2026-10-05", "b", "t", { kind: "changed", outcome: "failed" }),
        request("2026-09-30", "c", "t"),
      ],
      month,
      { perPerson: false, reach: noReach }
    );
    expect(report.total).toStrictEqual({ requests: 4, billed: 2, people: 2 });
    expect(report.notBilled).toStrictEqual({
      unanswered: 1,
      notPossible: 0,
      stopped: 0,
      failed: 1,
    });
    expect(report.bars).toHaveLength(31);
    expect(report.bars[1]).toStrictEqual({
      at: "2026-10-02",
      kinds: { answered: 1, lookedUp: 1, changed: 0, workflow: 0 },
      places: { teams: 2 },
      notBilled: 0,
    });
    expect(report.byKind.at(-1)).toMatchObject({
      key: "notBilled",
      requests: 2,
      billed: 0,
    });
  });

  it("fold every group of fewer than five people into one, so no row points at a few people", () => {
    const big = Array.from({ length: fewestPeople }, (_, index) =>
      request("2026-10-06", `big-${index}`, "team-big", { topic: "leave" })
    );
    const small = [
      request("2026-10-06", "x", "team-small"),
      request("2026-10-07", "x", "team-small"),
      request("2026-10-07", "y", "team-other"),
    ];
    const report = requestsReport([...big, ...small], month, {
      perPerson: false,
      reach: new Map([
        ["team-big", 6],
        ["team-small", 1],
        ["team-other", 1],
      ]),
    });
    expect(report.byTeam).toStrictEqual([
      { key: "team-big", requests: 5, billed: 5, people: 5, reach: 6 },
      { key: elsewhere, requests: 3, billed: 3, people: 2, reach: 0 },
    ]);
    expect(report.byTopic.map(({ key }) => key)).toStrictEqual([
      "leave",
      elsewhere,
    ]);
    expect(report.byTopic[0]?.tools).toStrictEqual([
      { key: brainTool, calls: 5 },
    ]);
    // A tool called for fewer than five people is folded too.
    expect(report.byTool).toStrictEqual([
      { key: brainTool, calls: 8, failed: 0, people: 7 },
    ]);
  });

  it("name a question many people ask only once five people have asked it, never one of a kind", () => {
    const report = requestsReport(
      [
        ...asked(5, "sick"),
        ...asked(4, "invoices"),
        request("2026-10-08", "q", "t"),
      ],
      month,
      { perPerson: false, reach: noReach }
    );
    expect(report.questions).toStrictEqual([
      {
        topic: "policies",
        question: "sick",
        requests: 5,
        people: 5,
        up: 0,
        down: 0,
      },
    ]);
  });

  it("count every tool he called for five or more people, the failures, and fold the rest", () => {
    const report = requestsReport(
      [
        ...Array.from({ length: 5 }, (_, index) =>
          request("2026-10-09", `a${index}`, "t", {
            tools: [
              { id: "microsoft.calendar_list", ok: true },
              { id: "microsoft.event_create", ok: index !== 0 },
            ],
          })
        ),
        request("2026-10-09", "b", "t", {
          tools: [{ id: "afas.leave", ok: false }],
        }),
      ],
      month,
      { perPerson: false, reach: noReach }
    );
    expect(report.byTool).toStrictEqual([
      { key: "microsoft.calendar_list", calls: 5, failed: 0, people: 5 },
      { key: "microsoft.event_create", calls: 5, failed: 1, people: 5 },
      { key: elsewhere, calls: 1, failed: 1, people: 1 },
    ]);
  });

  it("show people one by one only to whoever may see it, and then only as counts", () => {
    const requests = [
      request("2026-10-02", "a", "t"),
      request("2026-10-03", "a", "t", { outcome: "failed" }),
      request("2026-10-04", "b", "t"),
    ];
    const hidden = requestsReport(requests, month, {
      perPerson: false,
      reach: noReach,
    });
    const shown = requestsReport(requests, month, {
      perPerson: true,
      reach: noReach,
    });
    expect(hidden.byPerson).toBeNull();
    expect(shown.byPerson).toStrictEqual([
      { key: "a", requests: 2, billed: 1 },
      { key: "b", requests: 1, billed: 1 },
    ]);
    expect(shown.spread[0]).toStrictEqual({ least: 1, most: 2, people: 2 });
  });

  it("count the time saved by the minutes a request of each kind saves, the company's own where it set them", () => {
    const report = requestsReport(
      [
        request("2026-10-08", "a", "t"),
        request("2026-10-08", "b", "t", { kind: "workflow" }),
        request("2026-10-08", "c", "t", { outcome: "failed" }),
      ],
      month,
      { perPerson: false, reach: noReach }
    );
    expect(minutesSaved(report)).toBe(
      defaultMinutesSaved.answered + defaultMinutesSaved.workflow
    );
    expect(minutesSaved(report, { workflow: 45 })).toBe(
      defaultMinutesSaved.answered + 45
    );
  });

  it("call a question's answers poor once five people rated them, four or more and a quarter of the thumbs down", () => {
    const report = requestsReport(
      [
        ...rated(6, "rate", "up"),
        ...rated(4, "rate", "down"),
        ...rated(6, "chance", "up"),
        ...rated(2, "chance", "down"),
        ...rated(9, "fine", "up"),
        ...rated(1, "fine", "down"),
      ],
      month,
      { perPerson: false, reach: noReach }
    );
    expect(report.poorAnswers).toStrictEqual([
      { topic: "policies", question: "rate", people: 10, up: 6, down: 4 },
    ]);
    expect(report.thumbs).toStrictEqual({ up: 21, down: 7 });
  });

  it("keep what five or more people asked that he cannot do or did not know, with what it would take", () => {
    const report = requestsReport(
      [
        ...asked(5, "leave", {
          kind: "changed",
          outcome: "notPossible",
          tools: [],
          missing: [{ id: "afas.leave", why: "actionOff" }],
        }),
        ...asked(4, "rooms", {
          outcome: "notPossible",
          tools: [],
          missing: [{ id: "rooms", why: "noApp" }],
        }),
        ...asked(6, "bonus", { outcome: "unanswered" }),
      ],
      month,
      { perPerson: false, reach: noReach }
    );
    expect(report.notPossible).toStrictEqual([
      {
        topic: "policies",
        question: "leave",
        missing: [{ id: "afas.leave", why: "actionOff" }],
        requests: 5,
        people: 5,
      },
    ]);
    expect(report.unanswered).toStrictEqual([
      { topic: "policies", question: "bonus", requests: 6, people: 6 },
    ]);
    expect(report.total.billed).toBe(0);
  });

  it("hold this month against as many days of the last, and say what is new or grew by a fifth", () => {
    expect(spanBefore("month", today)).toStrictEqual({
      from: "2026-09-01",
      to: "2026-09-27",
      by: "day",
    });
    expect(spanBefore("month", "2026-03-31")).toStrictEqual({
      from: "2026-02-01",
      to: "2026-02-28",
      by: "day",
    });
    expect(spanBefore("lastMonth", today)).toStrictEqual({
      from: "2026-08-01",
      to: "2026-08-31",
      by: "day",
    });
    expect(spanBefore("year", today)).toBeNull();
    expect([
      growth(12, 0),
      growth(30, 20),
      growth(22, 20),
      growth(3, 0),
      growth(8, 5),
    ]).toStrictEqual(["new", 0.5, null, null, null]);
  });

  it("sum up the last whole week against the one before it", () => {
    expect(lastWeeks(today)).toStrictEqual({
      week: { from: "2026-10-19", to: "2026-10-25", by: "day" },
      before: { from: "2026-10-12", to: "2026-10-18", by: "day" },
    });
  });

  it("point at the teams that have hardly found him, folded counts and all", () => {
    const reach = new Map([
      ["busy", 10],
      ["quiet", 20],
      ["tiny", 3],
    ]);
    const report = requestsReport(
      [
        ...Array.from({ length: 8 }, (_, index) =>
          request("2026-10-08", `a${index}`, "busy")
        ),
        request("2026-10-08", "b0", "quiet"),
      ],
      month,
      { perPerson: false, reach }
    );
    expect(quietTeams(report, reach)).toStrictEqual([
      { teamId: "quiet", asked: null, reach: 20 },
    ]);
  });

  it("give the month's pace from the last week, run the line up to today, and none for a month that is over", () => {
    const report = requestsReport(steady(3), month, {
      perPerson: false,
      reach: noReach,
    });
    // Three a day, the last week as every other: 81 so far, 4 days left.
    expect(paceToEnd(report, today)).toBe(81 + 3 * 4);
    const line = runningTotal(report, today);
    expect(line.find(({ at }) => at === today)).toStrictEqual({
      at: today,
      total: 81,
      pace: 81,
    });
    expect(line.at(-1)).toStrictEqual({
      at: "2026-10-31",
      total: null,
      pace: 93,
    });
    const september = requestsReport(steady(3), rangeSpan("lastMonth", today), {
      perPerson: false,
      reach: noReach,
    });
    expect(paceToEnd(september, today)).toBeNull();
  });
});
