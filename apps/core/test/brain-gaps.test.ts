import type { BrainRecordInput } from "@grasp-os/shared/brain-records";
import { purgedMarker } from "@grasp-os/shared/knowledge";
import type { PurgeInput } from "@grasp-os/shared/knowledge";
import type { RosterInput } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

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

// The brain's teams and gaps (core's brain-records.ts and brain-gaps.ts):
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

type Signed = Awaited<ReturnType<typeof signedInApi>>;

/**
 * Saves a staff list on which each of `holders` has the title `role`, by
 * the email they sign in with, and Ann is the Finance team's accountant.
 */
const rosterWith = async (
  admin: Signed,
  role: string,
  ...holders: Signed[]
): Promise<void> => {
  await admin.api.onboarding.saveRoster({
    teams: roster.teams,
    people: [
      ...roster.people,
      ...holders.map(({ userId, person }, index) => ({
        id: `p-${userId}`.replaceAll(/[^A-Za-z0-9_-]/gu, "").slice(0, 60),
        name: `Holder ${index + 1}`,
        email: String(person.email),
        team: "finance",
        title: role,
      })),
    ],
  });
};

/** The questions `person` was asked, as their notifications list them. */
const askedOf = async (person: Signed) => {
  const { notifications } = await person.api.notifications.list();
  return notifications.flatMap((notice) =>
    notice.type === "gap_asked"
      ? [{ gap: notice.gap, question: notice.question, owner: notice.owner }]
      : []
  );
};

/** Grasp's staff, signed in to the deployment. */
const staff = async () => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session);
  return await core.authenticate();
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

describe("the brain's teams and gaps", { timeout: 120_000 }, () => {
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
        date: "2026-10-01",
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
      // By date: the records' of an earlier day, then the roster's own of
      // today, the newest counting.
      financeCounts: [
        { sourceId: `src-${tag}`, people: 2 },
        { sourceId: "src-roster", people: 1 },
      ],
      // The onboarding's team is the admin's to see; the records' isn't.
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

    expect(outcomes).toStrictEqual({
      teamCount: "brain.record_missing",
      statementTeam: "brain.record_missing",
      workflow: "brain.record_invalid",
      gapAbout: "brain.record_missing",
    });
  });

  it("refuse the onboarding's source ids as any record's own id, and a gap about what isn't a note", async () => {
    const admin = await signedInApi(idp, "admin");
    await admin.api.onboarding.saveRoster(roster);
    const tag = unique();
    const team = `team${tag}`;
    await admin.api.brain.addRecords([
      { type: "team", id: team, name: "Sales", sourceId: "src-roster" },
      {
        type: "teamCount",
        id: `count-${tag}`,
        teamId: team,
        sourceId: "src-roster",
        date: "2026-10-20",
        people: 4,
      },
    ]);
    const taking = (id: string): BrainRecordInput[] => [
      { type: "team", id, name: "Legal", sourceId: "src-roster" },
      {
        type: "teamCount",
        id,
        teamId: team,
        sourceId: "src-roster",
        date: "2026-10-20",
        people: 3,
      },
      {
        type: "stakeholder",
        id,
        teamId: team,
        sourceId: "src-roster",
        date: "2026-10-20",
        role: "Head of sales",
      },
      {
        type: "gap",
        id,
        question: "Who signs off on invoices?",
        owner: "Head of finance",
        sourceId: "src-roster",
        about: [],
      },
    ];
    const gapAbout = async (about: string) =>
      await outcome(
        admin.api.brain.addRecords([
          {
            type: "gap",
            id: `gap-${tag}-${about}`,
            question: "How big is the team?",
            owner: "Head of sales",
            sourceId: "src-roster",
            about: [about],
          },
        ])
      );

    const ownIds: Record<string, string> = {};
    for (const record of [...taking("src-roster"), ...taking("src-kickoff")]) {
      // oxlint-disable-next-line no-await-in-loop -- one call per record
      ownIds[`${record.type}:${record.id}`] = await outcome(
        admin.api.brain.addRecords([record])
      );
    }

    expect({
      ownIds,
      aboutTeam: await gapAbout(team),
      aboutCount: await gapAbout(`count-${tag}`),
      aboutSource: await gapAbout("src-roster"),
    }).toStrictEqual({
      ownIds: {
        "team:src-roster": "brain.record_invalid",
        "teamCount:src-roster": "brain.record_invalid",
        "stakeholder:src-roster": "brain.record_invalid",
        "gap:src-roster": "brain.record_invalid",
        "team:src-kickoff": "brain.record_invalid",
        "teamCount:src-kickoff": "brain.record_invalid",
        "stakeholder:src-kickoff": "brain.record_invalid",
        "gap:src-kickoff": "brain.record_invalid",
      },
      // A team record is a note; its count and the source aren't.
      aboutTeam: "ok",
      aboutCount: "brain.record_missing",
      aboutSource: "brain.record_missing",
    });
  });

  it("show members the onboarding source a gap or team names, and each team's values in date order", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    await admin.api.onboarding.saveRoster(roster);
    const tag = unique();
    const team = `team${tag}`;
    const source = `src-${tag}`;
    // The file's other tests share the database: none of their records
    // may name the staff list here.
    await env.DB.prepare(
      "DELETE FROM brain_records WHERE body LIKE '%\"src-roster\"%'"
    ).run();
    const sourcesOf = async () => {
      const read = await member.api.brain.read();
      return read.sources
        .map(({ id }) => id)
        .filter((id) => id === "src-roster");
    };
    const before = await sourcesOf();
    await admin.api.brain.addRecords([
      {
        type: "gap",
        id: `gap-${tag}`,
        question: "Who keeps the staff list?",
        owner: "Head of finance",
        sourceId: "src-roster",
        about: [],
      },
    ]);
    const withGap = await sourcesOf();
    await admin.api.brain.addRecords([
      {
        type: "source",
        id: source,
        kind: "interview",
        title: "Sales interview",
        date: "2026-10-22",
      },
      { type: "team", id: team, name: "Sales", sourceId: source },
      // Added out of date order: the brain reads them oldest first, a
      // day's values in the order they were added.
      ...[
        ["late", "2026-10-21", 6],
        ["early", "2026-10-20", 4],
        ["early-again", "2026-10-20", 5],
      ].map(([id, date, people]) => ({
        type: "teamCount" as const,
        id: `count-${tag}-${id}`,
        teamId: team,
        sourceId: source,
        date: String(date),
        people: Number(people),
      })),
      {
        type: "stakeholder",
        id: `holder-${tag}-late`,
        teamId: team,
        sourceId: source,
        date: "2026-10-21",
        role: "Head of sales",
      },
      {
        type: "stakeholder",
        id: `holder-${tag}-early`,
        teamId: team,
        sourceId: source,
        date: "2026-10-20",
        role: "Sales lead",
      },
      // Before the staff list was saved, for the roster's team.
      {
        type: "teamCount",
        id: `count-${tag}-finance`,
        teamId: "team-finance",
        sourceId: source,
        date: "2020-01-01",
        people: 2,
      },
    ]);
    const asMember = await member.api.brain.read();
    const asAdmin = await admin.api.brain.read();
    const sales = asMember.teams.find(({ id }) => id === team);

    expect({
      before,
      withGap,
      counts: sales?.counts.map(({ date, people }) => ({ date, people })),
      stakeholders: sales?.stakeholders.map(({ role }) => role),
      finance: asAdmin.teams
        .find(({ id }) => id === "team-finance")
        ?.counts.map(({ sourceId }) => sourceId)
        .filter((id) => id === source || id === "src-roster"),
    }).toStrictEqual({
      before: [],
      withGap: ["src-roster"],
      counts: [
        { date: "2026-10-20", people: 4 },
        { date: "2026-10-20", people: 5 },
        { date: "2026-10-21", people: 6 },
      ],
      stakeholders: ["Sales lead", "Head of sales"],
      finance: [source, "src-roster"],
    });
  });

  it("are asked by an admin once of who holds the role, answered once by any member in their own name, and audited without the answer", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const owner = await signedInApi(idp, "user");
    const { ids, records } = gapRecords(unique());
    await admin.api.brain.addRecords(records);
    // The question's role, as the staff list gives a title: case aside.
    await rosterWith(admin, "head of Finance", owner);
    const { name } = await member.api.whoami();

    const refusedAsk = await outcome(member.api.brain.askAboutGap(ids.gap));
    const refusedClose = await outcome(member.api.brain.closeGap(ids.gap));
    let asked: unknown;
    let answered: unknown;
    let toldOwner: unknown;
    let toldMember: unknown;
    const events = await auditedDuring(async () => {
      asked = await admin.api.brain.askAboutGap(ids.gap);
      await admin.api.brain.askAboutGap(ids.gap);
      toldOwner = await askedOf(owner);
      toldMember = await askedOf(member);
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
      toldOwner,
      toldMember,
      answered,
      events: events
        .filter(({ action }) => action.startsWith("brain.gap"))
        .map(({ action, target, detail, provenance }) => ({
          action,
          target,
          detail,
          provenance,
        })),
      again,
      // An answered question is no longer the owner's to answer.
      ownerAfter: await askedOf(owner),
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
      // The owner is asked, once however often the admin asks; nobody else.
      toldOwner: [
        {
          gap: ids.gap,
          question: "How many invoices come in a month?",
          owner: "Head of finance",
        },
      ],
      toldMember: [],
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
      // Asked once, however often, naming whom by id; the answer itself
      // isn't in the log.
      events: [
        {
          action: "brain.gap.asked",
          target: { type: "brain_gap", id: ids.gap },
          detail: { asked: 1 },
          provenance: [owner.userId],
        },
        {
          action: "brain.gap.answered",
          target: { type: "brain_gap", id: ids.gap },
          detail: {},
          provenance: [],
        },
      ],
      again: {
        answer: "brain.gap_closed",
        close: "brain.gap_closed",
        ask: "brain.gap_closed",
      },
      ownerAfter: [],
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

  it("aren't asked, nor shown as asked, when nobody who can sign in holds the role", async () => {
    const admin = await signedInApi(idp, "admin");
    const owner = await signedInApi(idp, "user");
    const leaver = await signedInApi(idp, "user");
    const { ids, records } = gapRecords(unique());
    await admin.api.brain.addRecords(records);

    // Nobody on the staff list has the role.
    await rosterWith(admin, "Head of sales", owner);
    const noTitle = await outcome(admin.api.brain.askAboutGap(ids.gap));
    // The only one who has it was removed from the organization.
    await rosterWith(admin, "Head of finance", leaver);
    await admin.api.members.remove(leaver.userId);
    const removed = await outcome(admin.api.brain.askAboutGap(ids.gap));
    const read = await admin.api.brain.read();

    expect({
      noTitle,
      removed,
      askedAt: read.gaps.find(({ id }) => id === ids.gap)?.askedAt,
      told: await askedOf(owner),
    }).toStrictEqual({
      noTitle: "brain.gap_no_owner",
      removed: "brain.gap_no_owner",
      askedAt: undefined,
      told: [],
    });
  });

  it("are refused as closed when an answer lands while the ask is made, and asked of the owner once when two admins ask at once", async () => {
    const admin = await signedInApi(idp, "admin");
    const other = await signedInApi(idp, "admin");
    const owner = await signedInApi(idp, "user");
    await rosterWith(admin, "Head of finance", owner);
    const answered = gapRecords(unique());
    const twice = gapRecords(unique());
    await admin.api.brain.addRecords([...answered.records, ...twice.records]);

    /** Asks `gap` as the admin while `racing` lands just before its write. */
    const racedBy = async (
      gap: string,
      racing: () => Promise<unknown>
    ): Promise<unknown> => {
      const prepare = env.DB.prepare.bind(env.DB);
      const batch = env.DB.batch.bind(env.DB);
      let writing = false;
      let raced = false;
      const prepared = vi
        .spyOn(env.DB, "prepare")
        .mockImplementation((query) => {
          writing ||=
            !raced && query.startsWith('insert into "brain_gap_states"');
          return prepare(query);
        });
      const batched = vi
        .spyOn(env.DB, "batch")
        .mockImplementation(async (statements) => {
          if (writing && !raced) {
            raced = true;
            await racing();
          }
          return await batch(statements);
        });
      try {
        return await outcome(admin.api.brain.askAboutGap(gap));
      } finally {
        prepared.mockRestore();
        batched.mockRestore();
      }
    };

    const closed = await racedBy(
      answered.ids.gap,
      async () =>
        await owner.api.brain.answerGap(answered.ids.gap, "About 400.")
    );
    const asked = await racedBy(
      twice.ids.gap,
      async () => await other.api.brain.askAboutGap(twice.ids.gap)
    );

    const told = await askedOf(owner);
    expect({
      closed,
      asked,
      told: told.map(({ gap }) => gap),
    }).toStrictEqual({
      closed: "brain.gap_closed",
      asked: "ok",
      told: [twice.ids.gap],
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

describe("the brain's gap answers", { timeout: 120_000 }, () => {
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
      planned: contentPlan.hostCopies,
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
