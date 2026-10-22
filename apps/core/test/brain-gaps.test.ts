import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import type { BrainRecordInput } from "@grasp-os/shared/brain-records";
import { purgedMarker } from "@grasp-os/shared/knowledge";
import type { PurgeInput } from "@grasp-os/shared/knowledge";
import type { RosterInput } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { fakeGateway } from "./ai-gateway.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

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

/** Grasp's staff, signed in to the deployment. */
const staff = async () => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session);
  return await core.authenticate();
};

/** Staff bring a kickoff in that names a team the roster doesn't have. */
const bringInKickoff = async (): Promise<void> => {
  const api = await staff();
  const fake = fakeGateway({
    text: JSON.stringify({
      fields: [],
      teams: [{ name: "Legal", does: "Contracts", people: 3 }],
    }),
    inputTokens: 900,
    outputTokens: 300,
  });
  const ai: AiBinding = env.AI;
  const spy = vi.spyOn(ai, "fetch").mockImplementation(fake.binding.fetch);
  try {
    await api.onboardingStaff.saveKickoff({
      locale: "en",
      transcript: {
        text: `Anna (CEO): We are an accounting firm in Utrecht with two teams.
Jakob (Grasp): Where do you want to be in two years?
Anna (CEO): We want every client to get their numbers within a week, and AI should help us get there.
Anna (CEO): Our Finance team has 8 people and spends days copying invoices by hand.
Anna (CEO): Our Legal team of 3 handles the contracts.`,
      },
    });
  } finally {
    spy.mockRestore();
  }
};

/** Saves `text` as a note in `person`'s Personal collection. */
const noteOf = async (
  person: Awaited<ReturnType<typeof signedInApi>>,
  text: string
) => {
  const { personal } = await person.api.memory.collections();
  return await person.api.knowledge.saveDocument({
    collectionId: personal,
    path: `notes/${unique()}.md`,
    text,
    ifVersion: 0,
  });
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
    const team = `sales-${tag}`;
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
      roster: await outcome(
        admin.api.brain.addRecords([
          {
            type: "team",
            id: "team-finance",
            name: "Finance",
            sourceId: `src-${tag}`,
          },
        ])
      ),
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
      // A roster team's id, now or later, is never a team record's.
      roster: "brain.record_invalid",
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

    // A kickoff-only team takes no values: its id is its place in the
    // reading, which reading the kickoff again moves.
    await bringInKickoff();
    const withKickoff = await admin.api.brain.read();
    const kickoffTeams = withKickoff.teams
      .map(({ id }) => id)
      .filter((id) => id.startsWith("team.kickoff-"));
    const kickoffCount = await outcome(
      admin.api.brain.addRecords([
        {
          type: "teamCount",
          id: `${ids.source}-kickoff`,
          teamId: kickoffTeams[0] ?? "team.kickoff-0",
          sourceId: ids.source,
          date: "2026-10-20",
          people: 3,
        },
      ])
    );

    expect({ ...outcomes, kickoffTeams, kickoffCount }).toStrictEqual({
      kickoffTeams: ["team.kickoff-0"],
      kickoffCount: "brain.record_missing",
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

describe("the Playbook's gap answers", { timeout: 120_000 }, () => {
  it("show who answered by their name now, and are never answered, asked about or closed by Grasp's staff", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const { ids, records } = gapRecords(unique());
    await admin.api.brain.addRecords(records);
    const grasp = await staff();

    const byStaff = {
      ask: await outcome(grasp.brain.askAboutGap(ids.gap)),
      answer: await outcome(grasp.brain.answerGap(ids.gap, "About 400.")),
      close: await outcome(grasp.brain.closeGap(ids.gap)),
    };
    await member.api.brain.answerGap(ids.gap, "About 400.");
    await env.DB.prepare("UPDATE users SET name = ? WHERE id = ?")
      .bind("Renamed Person", member.userId)
      .run();
    const read = await admin.api.brain.read();

    expect({
      byStaff,
      answeredBy: read.gaps.find(({ id }) => id === ids.gap)?.answeredBy,
    }).toStrictEqual({
      byStaff: {
        ask: "role.forbidden",
        answer: "role.forbidden",
        close: "role.forbidden",
      },
      answeredBy: "Renamed Person",
    });
  });

  it("are redacted by the company's admins alone, keeping the gap closed, and audited", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const { ids, records } = gapRecords(unique());
    await admin.api.brain.addRecords(records);
    await member.api.brain.answerGap(ids.gap, "Ask Ann, she knows.");

    const byMember = await outcome(member.api.brain.redactGapAnswer(ids.gap));
    let redacted: unknown;
    const events = await auditedDuring(async () => {
      redacted = await admin.api.brain.redactGapAnswer(ids.gap);
    });
    const read = await member.api.brain.read();
    const gap = read.gaps.find(({ id }) => id === ids.gap);

    expect({
      byMember,
      redacted,
      gap,
      events: events
        .filter(({ action }) => action.startsWith("brain.gap"))
        .map(({ action, target }) => ({ action, target })),
    }).toStrictEqual({
      byMember: "role.forbidden",
      redacted: gap,
      gap: {
        id: ids.gap,
        question: "How many invoices come in a month?",
        owner: "Head of finance",
        sourceId: ids.source,
        about: [ids.candidate],
        closedAt: new Date().toISOString().slice(0, 10),
      },
      events: [
        {
          action: "brain.gap.redacted",
          target: { type: "brain_gap", id: ids.gap },
        },
      ],
    });
  });

  it("lose a purged term, and who gave them once that person is purged", async () => {
    const admin = await signedInApi(idp, "admin");
    const leaver = await signedInApi(idp, "user");
    const tag = unique();
    const name = `Visser${tag}`;
    const { ids, records } = gapRecords(tag);
    await admin.api.brain.addRecords(records);
    await leaver.api.brain.answerGap(ids.gap, `Ask ${name}, she knows.`);
    const note = await noteOf(leaver, `# Leaving\n${name} hands over.`);

    const content: PurgeInput = {
      type: "content",
      documentIds: [note.id],
      terms: [name],
      reason: "erasure_request",
    };
    const contentPlan = await admin.api.knowledge.preparePurge(content);
    await admin.api.knowledge.purge(content, contentPlan.token);
    const readAfterContent = await admin.api.brain.read();
    const afterContent = readAfterContent.gaps.find(({ id }) => id === ids.gap);
    const personal: PurgeInput = {
      type: "personal",
      userId: leaver.userId,
      reason: "offboarding",
    };
    const personalPlan = await admin.api.knowledge.preparePurge(personal);
    await admin.api.knowledge.purge(personal, personalPlan.token);
    const readAfterPersonal = await admin.api.brain.read();
    const afterPersonal = readAfterPersonal.gaps.find(
      ({ id }) => id === ids.gap
    );

    expect({
      planned: contentPlan.gapAnswers,
      contentAnswer: afterContent?.answer,
      answeredBy: afterPersonal?.answeredBy,
      answer: afterPersonal?.answer,
    }).toStrictEqual({
      planned: 1,
      contentAnswer: `Ask ${purgedMarker}, she knows.`,
      answeredBy: undefined,
      answer: `Ask ${purgedMarker}, she knows.`,
    });
  });

  it("lose a purged term though a document's purge fails", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const name = `Visser${tag}`;
    const { ids, records } = gapRecords(tag);
    await admin.api.brain.addRecords(records);
    await admin.api.brain.answerGap(ids.gap, `Ask ${name}, she knows.`);
    const note = await noteOf(admin, `# Handover\n${name} hands over.`);
    const input: PurgeInput = {
      type: "content",
      documentIds: [note.id],
      terms: [name],
      reason: "erasure_request",
    };
    const plan = await admin.api.knowledge.preparePurge(input);
    // The Knowledge database records the purge, then refuses the batch
    // that rewrites the document's versions.
    const real = env.KNOWLEDGE;
    let rewriting = false;
    const knowledge: D1Database = {
      prepare: (query) => {
        rewriting ||= query.startsWith('update "versions"');
        return real.prepare(query);
      },
      batch: async <T>(statements: D1PreparedStatement[]) => {
        if (rewriting) {
          throw new Error("D1 is unavailable");
        }
        return await real.batch<T>(statements);
      },
      exec: async (query) => await real.exec(query),
      // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
      dump: async () => await real.dump(),
      withSession: (constraint) => real.withSession(constraint),
    };
    const { core } = await openRpc(admin.session, {
      coreEnv: { ...env, KNOWLEDGE: knowledge },
    });
    const failing = await core.authenticate();
    const purged = await outcome(failing.knowledge.purge(input, plan.token));
    const read = await admin.api.brain.read();

    expect({
      purged: purged === "ok",
      answer: read.gaps.find(({ id }) => id === ids.gap)?.answer,
    }).toStrictEqual({
      purged: false,
      answer: `Ask ${purgedMarker}, she knows.`,
    });
  });
});
