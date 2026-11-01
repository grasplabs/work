import type { BrainRecordInput } from "@grasp-os/shared/brain-records";
import type { WorkKnowledge } from "@grasp-os/shared/work-knowledge";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// A piece of work's Knowledge tab (brain-work.ts), from its threat model
// (packages/shared/src/work-knowledge.ts): a sentence never carries a
// quote, a name or a day, only the brain's own words and the week; a role
// is named only where five or more of its team hold it, and only once
// five or more people told about the work; how sure Grasp is says enough
// or not yet, never how many; and what the brain lets go of is gone from
// the tab with it. Asking for more voices is the company's admins'.

const idp = mockIdp();

const day = "2026-10-14";
/** 14 October 2026 is a Wednesday of ISO week 42. */
const week = "2026-W42";

/** Records an admin adds, ids made unique for this test. */
const recordsOf = (
  ids: {
    team: string;
    sources: string[];
    candidate: string;
    statements: string[];
  },
  roles: { name: string; people: number }[],
  told: { role: string; text: string }[]
): BrainRecordInput[] => [
  // Where the team was first found: a list of the company's teams.
  {
    type: "source",
    id: `${ids.team}-list`,
    kind: "import",
    title: "Teams",
    date: day,
    teamIds: [],
  },
  {
    type: "team",
    id: ids.team,
    name: "Accounts payable",
    sourceId: `${ids.team}-list`,
  },
  {
    type: "teamCount",
    id: `count-${unique()}`,
    teamId: ids.team,
    sourceId: `${ids.team}-list`,
    date: day,
    people: 12,
    roles,
  },
  ...ids.sources.slice(0, told.length).map((id, index): BrainRecordInput => ({
    type: "source",
    id,
    kind: "interview",
    title: `Interview ${index}`,
    date: day,
    who: told[index]?.role ?? "Clerk",
    how: "Live, 45 minutes",
    interviewee: "employee",
    teamIds: [ids.team],
  })),
  { type: "candidate", id: ids.candidate, name: "Paying invoices" },
  ...told.map(({ text }, index): BrainRecordInput => ({
    type: "statement",
    id: ids.statements[index] ?? "",
    kind: "blocker",
    text,
    sourceId: ids.sources[index] ?? "",
    teamIds: [ids.team],
    toolIds: [],
    candidateId: ids.candidate,
  })),
];

/** `count` new ids with `prefix`. */
const idsOf = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, () => `${prefix}-${unique()}`);

/** Every date in `value`, written as a day. */
const daysIn = (value: unknown): string[] =>
  JSON.stringify(value).match(/\d{4}-\d{2}-\d{2}/gu) ?? [];

/** Writes a record as the onboarding gives the brain one. */
const insert = async (body: Record<string, unknown>) => {
  await env.DB.prepare(
    "INSERT INTO brain_records (type, id, body, added_at) VALUES (?, ?, ?, ?)"
  )
    .bind(body.type, body.id, JSON.stringify(body), Date.now())
    .run();
};

describe("a piece of work's knowledge", () => {
  it("tells only the brain's own sentences and their week, and names who only once five or more told it, by a role five or more hold", async () => {
    const [admin, member] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const told = [
      {
        role: "Clerk",
        text: "Invoices wait for approval when the manager is away.",
      },
      { role: "Controller", text: "Approvals get lost in email." },
      { role: "Clerk", text: "Supplier numbers are typed in by hand." },
      { role: "Clerk", text: "Credit notes are matched by hand." },
    ];
    const ids = {
      team: `ap-${unique()}`,
      sources: idsOf("src", 5),
      candidate: `cand-${unique()}`,
      statements: idsOf("st", 5),
    };
    const roles = [
      { name: "Clerk", people: 6 },
      // Two hold it: naming it would point at them.
      { name: "Controller", people: 2 },
    ];
    // Four people told about the work.
    await admin.api.brain.addRecords(recordsOf(ids, roles, told));

    const four = await member.api.brain.work(ids.candidate);
    expect({
      sentences: four.sentences.map(({ text, restsOn, week: at, by }) => ({
        text,
        restsOn,
        week: at,
        by,
      })),
      confidence: four.confidence,
      canAskMore: four.canAskMore,
    }).toStrictEqual({
      sentences: told.map(({ text }) => ({
        text,
        restsOn: "said",
        week,
        by: null,
      })),
      confidence: "waiting",
      // Asking for more voices is the admins'.
      canAskMore: false,
    });
    // Never a day, a source's title or how it was told.
    const said = JSON.stringify(four);
    expect({
      days: daysIn(four),
      titles: said.includes("Interview "),
      how: said.includes("45 minutes"),
    }).toStrictEqual({ days: [], titles: false, how: false });

    // A fifth tells it: who said each shows, by a role five or more hold.
    await admin.api.brain.addRecords([
      {
        type: "source",
        id: ids.sources[4] ?? "",
        kind: "interview",
        title: "Interview 4",
        date: day,
        who: "Clerk",
        teamIds: [ids.team],
      },
      {
        type: "statement",
        id: ids.statements[4] ?? "",
        kind: "wish",
        text: "Would like approvals in one place.",
        sourceId: ids.sources[4] ?? "",
        teamIds: [ids.team],
        toolIds: [],
        candidateId: ids.candidate,
      },
    ]);
    const five = await member.api.brain.work(ids.candidate);
    expect({
      by: five.sentences.map(({ by }) => by),
      confidence: five.confidence,
    }).toStrictEqual({
      by: [
        { team: "Accounts payable", role: "Clerk" },
        // Two controllers: the team alone.
        { team: "Accounts payable", role: null },
        { team: "Accounts payable", role: "Clerk" },
        { team: "Accounts payable", role: "Clerk" },
        { team: "Accounts payable", role: "Clerk" },
      ],
      confidence: "heard",
    });
    // How sure, never how many.
    expect(JSON.stringify(five)).not.toMatch(/"(?:people|tellers|count)"/u);
  });

  it("tells a drawn piece of work as its newest drawing does, and lets go of what a drawing drawn again no longer says", async () => {
    const member = await signedInApi(idp, "user");
    const workflow = `onb-wf-${unique().replaceAll("-", "").slice(0, 32)}`;
    const drawing = (people: number, decides: string, date: string) => ({
      type: "workflowVersion",
      id: `onb-wv-${unique().replaceAll("-", "").slice(0, 32)}`,
      workflowId: workflow,
      sourceId: "onb-src-0123456789abcdef0123456789abcdef",
      date,
      state: "saturating",
      people,
      starts: "An invoice arrives by email.",
      steps: [
        {
          text: "Check the invoice against the order.",
          who: "",
          tool: "",
          minutes: null,
          documented: true,
        },
      ],
      waits: [],
      differently: [],
      decides,
      own: "",
      ai: "",
      right: "",
      ask: "",
      next: "",
      term: null,
      differs: null,
      volumes: [],
      takes: null,
      wrong: null,
      open: [],
    });
    await insert({
      type: "workflow",
      id: workflow,
      name: "Paying invoices",
      teamId: "team-unknown",
      sourceId: "onb-src-0123456789abcdef0123456789abcdef",
      status: "drawn",
    });
    await insert(drawing(6, "The controller decides above the limit.", day));
    const first = await member.api.brain.work(workflow);
    expect({
      sentences: first.sentences.map(({ about, text, restsOn, week: at }) => ({
        about,
        text,
        restsOn,
        week: at,
      })),
      confidence: first.confidence,
    }).toStrictEqual({
      sentences: [
        {
          about: "today",
          text: "An invoice arrives by email.",
          restsOn: "said",
          week,
        },
        {
          about: "today",
          text: "Check the invoice against the order.",
          restsOn: "written",
          week,
        },
        {
          about: "rule",
          text: "The controller decides above the limit.",
          restsOn: "said",
          week,
        },
      ],
      confidence: "heard",
    });
    // Drawn again once someone was erased: four people, nobody decides.
    await insert(drawing(4, "", "2026-10-21"));
    const again = await member.api.brain.work(workflow);
    expect({
      decides: again.sentences.some(({ about }) => about === "rule"),
      weeks: [...new Set(again.sentences.map(({ week: at }) => at))],
      confidence: again.confidence,
    }).toStrictEqual({
      decides: false,
      weeks: ["2026-W43"],
      confidence: "waiting",
    });
  });

  it("asks for more voices only for the company's admins, and only about a piece of work the onboarding has", async () => {
    const [admin, member] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const candidate = `cand-${unique()}`;
    await admin.api.brain.addRecords([
      { type: "candidate", id: candidate, name: "Closing the month" },
    ]);
    const asAdmin: WorkKnowledge = await admin.api.brain.work(candidate);
    expect(asAdmin.canAskMore).toBeTruthy();
    await expect(
      outcome(member.api.brain.askMorePeople(candidate))
    ).resolves.toBe("role.forbidden");
    // A piece of work the brain was given, not one the onboarding draws.
    await expect(
      outcome(admin.api.brain.askMorePeople(candidate))
    ).resolves.toBe("brain.work_not_found");
    await expect(
      outcome(member.api.brain.work(`cand-${unique()}`))
    ).resolves.toBe("brain.work_not_found");
  });
});
