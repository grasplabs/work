import type { BrainRecordInput } from "@grasp-os/shared/brain-records";
import type { RosterInput } from "@grasp-os/shared/onboarding";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// The Playbook's teams and gaps (core's brain-records.ts and brain-gaps.ts):
// a team's sizes and stakeholders added as dated values, joining the
// onboarding's team of the same id for whoever reads it; a gap asked
// about, answered or closed once each. What can go wrong, tried here (the
// threat note is on GRA-527): a value for a team or record that doesn't
// exist; the onboarding's teams reaching someone who isn't an admin; a gap
// asked about or closed unanswered by someone who isn't an admin; an
// answer written over, or a closed gap reopened; an answer in the audit
// log.

const idp = mockIdp();

const roster: RosterInput = {
  teams: [{ id: "finance", name: "Finance", lead: null }],
  people: [{ id: "ann", name: "Ann", team: "finance", title: "Accountant" }],
};

/** A source, and a gap noticed in it, about a candidate. */
const gapRecords = (tag: string) => {
  const ids = {
    source: `src-${tag}`,
    candidate: `cand-${tag}`,
    gap: `gap-${tag}`,
  };
  const records: BrainRecordInput[] = [
    {
      type: "source",
      id: ids.source,
      kind: "interview",
      title: "Finance interview",
      date: "2026-10-20",
    },
    { type: "candidate", id: ids.candidate, name: "Invoice entry" },
    {
      type: "gap",
      id: ids.gap,
      question: "How many invoices come in a month?",
      owner: "Head of finance",
      sourceId: ids.source,
      about: [ids.candidate],
    },
  ];
  return { ids, records };
};

describe("the Playbook's teams and gaps", { timeout: 120_000 }, () => {
  it("add a team's sizes and stakeholders as dated values, joining the onboarding's team for admins alone", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    await admin.api.onboarding.saveRoster(roster);
    const tag = unique();
    const team = `team-${tag}`;
    await admin.api.brain.addRecords([
      {
        type: "source",
        id: `src-${tag}`,
        kind: "interview",
        title: "Sales interview",
        date: "2026-10-20",
        teamIds: ["team-finance"],
      },
      { type: "team", id: team, name: "Sales", sourceId: `src-${tag}` },
      {
        type: "teamCount",
        id: `count-${tag}-1`,
        teamId: team,
        sourceId: `src-${tag}`,
        date: "2026-10-20",
        people: 4,
        roles: [{ name: "Account manager", people: 3 }],
      },
      {
        type: "stakeholder",
        id: `holder-${tag}`,
        teamId: team,
        sourceId: `src-${tag}`,
        date: "2026-10-20",
        role: "Head of sales",
      },
      // Said in the Sales interview about the roster's Finance team.
      {
        type: "teamCount",
        id: `count-${tag}-2`,
        teamId: "team-finance",
        sourceId: `src-${tag}`,
        date: "2026-10-21",
        people: 2,
      },
    ]);

    const asAdmin = await admin.api.brain.read();
    const asMember = await member.api.brain.read();

    expect({
      sales: asAdmin.teams.find(({ id }) => id === team),
      financeCounts: asAdmin.teams
        .find(({ id }) => id === "team-finance")
        ?.counts.map(({ sourceId, people }) => ({ sourceId, people })),
      memberTeams: asMember.teams.map(({ id }) => id),
    }).toStrictEqual({
      sales: {
        id: team,
        name: "Sales",
        sourceId: `src-${tag}`,
        counts: [
          {
            sourceId: `src-${tag}`,
            date: "2026-10-20",
            people: 4,
            roles: [{ name: "Account manager", people: 3 }],
          },
        ],
        stakeholders: [
          { sourceId: `src-${tag}`, date: "2026-10-20", role: "Head of sales" },
        ],
      },
      // The roster's own count, then the Playbook's, the newest counting.
      financeCounts: [
        { sourceId: "src-roster", people: 1 },
        { sourceId: `src-${tag}`, people: 2 },
      ],
      // The onboarding's team is the admin's to see; the Playbook's isn't.
      memberTeams: [team],
    });
  });

  it("refuse a team, workflow or record that doesn't exist", async () => {
    const admin = await signedInApi(idp, "admin");
    await admin.api.onboarding.saveRoster(roster);
    const { ids, records } = gapRecords(unique());
    await admin.api.brain.addRecords(records.slice(0, 2));

    // Core keeps no drawn workflows to check one against yet.
    const withWorkflow = {
      type: "candidate" as const,
      id: `${ids.candidate}-2`,
      name: "Expense claims",
      workflowId: "wf-1",
    };
    const outcomes = {
      teamCount: await outcome(
        admin.api.brain.addRecords([
          {
            type: "teamCount",
            id: `${ids.source}-count`,
            teamId: "team-nowhere",
            sourceId: ids.source,
            date: "2026-10-20",
            people: 3,
          },
        ])
      ),
      statementTeam: await outcome(
        admin.api.brain.addRecords([
          {
            type: "statement",
            id: `${ids.source}-st`,
            kind: "goal",
            text: "Close the books in three days.",
            sourceId: ids.source,
            teamIds: ["team-nowhere"],
          },
        ])
      ),
      // Core keeps no drawn workflows to check one against yet.
      workflow: await outcome(admin.api.brain.addRecords([withWorkflow])),
      gapAbout: await outcome(
        admin.api.brain.addRecords([
          {
            type: "gap",
            id: `${ids.gap}-2`,
            question: "Who signs off on invoices?",
            owner: "Head of finance",
            sourceId: ids.source,
            about: ["st-nowhere"],
          },
        ])
      ),
    };

    expect(outcomes).toStrictEqual({
      teamCount: "brain.record_missing",
      statementTeam: "brain.record_missing",
      workflow: "brain.record_invalid",
      gapAbout: "brain.record_missing",
    });
  });

  it("are asked about once by an admin, answered once by any member in their own name, and audited without the answer", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const { ids, records } = gapRecords(unique());
    await admin.api.brain.addRecords(records);
    const { name } = await member.api.whoami();

    const refusedAsk = await outcome(member.api.brain.askAboutGap(ids.gap));
    const refusedClose = await outcome(member.api.brain.closeGap(ids.gap));
    let asked: unknown;
    let answered: unknown;
    const events = await auditedDuring(async () => {
      asked = await admin.api.brain.askAboutGap(ids.gap);
      await admin.api.brain.askAboutGap(ids.gap);
      answered = await member.api.brain.answerGap(ids.gap, "About 400.");
    });
    const again = {
      answer: await outcome(admin.api.brain.answerGap(ids.gap, "About 500.")),
      close: await outcome(admin.api.brain.closeGap(ids.gap)),
      ask: await outcome(admin.api.brain.askAboutGap(ids.gap)),
    };
    const read = await member.api.brain.read();
    const today = new Date().toISOString().slice(0, 10);

    expect({
      refusedAsk,
      refusedClose,
      asked,
      answered,
      events: events
        .filter(({ action }) => action.startsWith("brain.gap"))
        .map(({ action, target, detail }) => ({ action, target, detail })),
      again,
      gap: read.gaps.find(({ id }) => id === ids.gap),
    }).toStrictEqual({
      refusedAsk: "role.forbidden",
      refusedClose: "role.forbidden",
      asked: {
        id: ids.gap,
        question: "How many invoices come in a month?",
        owner: "Head of finance",
        sourceId: ids.source,
        about: [ids.candidate],
        askedAt: today,
      },
      answered: {
        id: ids.gap,
        question: "How many invoices come in a month?",
        owner: "Head of finance",
        sourceId: ids.source,
        about: [ids.candidate],
        askedAt: today,
        closedAt: today,
        answer: "About 400.",
        answeredBy: name,
      },
      // Asked once, however often; the answer itself isn't in the log.
      events: [
        {
          action: "brain.gap.asked",
          target: { type: "brain_gap", id: ids.gap },
          detail: {},
        },
        {
          action: "brain.gap.answered",
          target: { type: "brain_gap", id: ids.gap },
          detail: {},
        },
      ],
      again: {
        answer: "brain.gap_closed",
        close: "brain.gap_closed",
        ask: "brain.gap_closed",
      },
      gap: {
        id: ids.gap,
        question: "How many invoices come in a month?",
        owner: "Head of finance",
        sourceId: ids.source,
        about: [ids.candidate],
        askedAt: today,
        closedAt: today,
        answer: "About 400.",
        answeredBy: name,
      },
    });
  });

  it("are closed unanswered by an admin, and refuse what isn't a gap or an answer", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const { ids, records } = gapRecords(unique());
    await admin.api.brain.addRecords(records);

    const outcomes = {
      empty: await outcome(member.api.brain.answerGap(ids.gap, "   ")),
      unknown: await outcome(member.api.brain.answerGap("gap-nowhere", "Yes.")),
      notAGap: await outcome(member.api.brain.answerGap(ids.candidate, "Yes.")),
    };
    const closed = await admin.api.brain.closeGap(ids.gap);
    const answerAfter = await outcome(
      member.api.brain.answerGap(ids.gap, "Yes.")
    );

    expect({
      outcomes,
      closed: {
        answer: closed.answer,
        closedAt: closed.closedAt !== undefined,
      },
      answerAfter,
    }).toStrictEqual({
      outcomes: {
        empty: "brain.gap_invalid",
        unknown: "brain.gap_not_found",
        notAGap: "brain.gap_not_found",
      },
      closed: { answer: undefined, closedAt: true },
      answerAfter: "brain.gap_closed",
    });
  });
});
