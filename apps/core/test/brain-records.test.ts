import type { BrainRecordInput } from "@grasp-os/shared/brain-records";
import {
  brainRecordsMaxPerCall,
  brainRecordsMaxPerType,
  purgedMarker,
} from "@grasp-os/shared/brain-records";
import type { RosterInput } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// The brain's records (`brain.addRecords`, core's brain-records.ts), as
// an admin adds them and every member reads them in `brain.read`. What
// can go wrong, tried here (the threat note is on GRA-527): someone who
// isn't an admin writing the brain; a record written over, or a retry
// failing; a statement whose source, tool, candidate or earlier statement
// doesn't exist; a record carrying more than it may (a transcript), or a
// pain on what doesn't hurt; a flood past a type's cap; a change kept
// without its audit event, or a call half kept; a purged name or passage
// left in a record, reaching agents through the brain, or put back by the
// same record sent again.

const idp = mockIdp();

/**
 * Who works where: what makes the staff list a source the brain has. Five
 * accountants, so a source may say an accountant gave it; one head of
 * finance, who no source may name by role.
 */
const roster: RosterInput = {
  teams: [{ id: "finance", name: "Finance", lead: null }],
  people: [
    ...["Ann", "Bo", "Cas", "Dex", "Eli"].map((name) => ({
      id: name.toLowerCase(),
      name,
      team: "finance",
      title: "Accountant",
    })),
    { id: "fay", name: "Fay", team: "finance", title: "Head of finance" },
  ],
};

/** One interview's records, under ids no other test uses. */
const interview = (tag: string) => {
  const ids = {
    source: `src-${tag}`,
    tool: `tool-${tag}`,
    candidate: `cand-${tag}`,
    blocker: `st-${tag}-1`,
    followUp: `st-${tag}-2`,
    wish: `st-${tag}-3`,
  };
  const records: BrainRecordInput[] = [
    {
      type: "source",
      id: ids.source,
      kind: "interview",
      title: "Finance interview",
      date: "2026-10-20",
      who: "Head of finance",
      how: "Live, 45 minutes",
      step: 2,
      interviewee: "stakeholder",
      teamIds: ["team-finance"],
    },
    {
      type: "tool",
      id: ids.tool,
      name: "Exact Online",
      teamIds: ["team-finance"],
      sourceId: ids.source,
      ai: "none",
    },
    { type: "candidate", id: ids.candidate, name: "Invoice entry" },
    {
      type: "statement",
      id: ids.blocker,
      kind: "blocker",
      text: "Invoices are typed over by hand.",
      sourceId: ids.source,
      teamIds: ["team-finance"],
      toolIds: [ids.tool],
      candidateId: ids.candidate,
      pain: "high",
    },
    {
      type: "statement",
      id: ids.followUp,
      kind: "blocker",
      text: "Typing invoices over still takes a day a week.",
      sourceId: ids.source,
      teamIds: ["team-finance"],
      toolIds: [ids.tool],
      candidateId: ids.candidate,
      followsUp: ids.blocker,
      pain: "medium",
    },
    {
      type: "statement",
      id: ids.wish,
      kind: "wish",
      // Its source can be the onboarding's own, once it exists: the staff
      // list.
      text: "Clients get their numbers within a week.",
      sourceId: "src-roster",
    },
  ];
  return { ids, records };
};

describe("the brain's records", { timeout: 120_000 }, () => {
  it("are added by an admin, read by every member in the brain, and audited", async () => {
    const admin = await signedInApi(idp, "admin");
    await admin.api.onboarding.saveRoster(roster);
    const member = await signedInApi(idp, "user");
    const { ids, records: interviewed } = interview(unique());
    // Given by an accountant, one of five: their role may show.
    const accountants: BrainRecordInput = {
      type: "source",
      id: `${ids.source}-accountants`,
      kind: "interview",
      title: "Finance interviews",
      date: "2026-10-21",
      who: "Accountant",
      step: 2,
      teamIds: ["team-finance"],
    };
    const records = [...interviewed, accountants];

    let added: unknown;
    const events = await auditedDuring(async () => {
      added = await admin.api.brain.addRecords(records);
    });
    const workspace = await member.api.brain.read();
    // An admin reads the staff list's roles, so the role of one of five
    // shows; a member reads the counts only as records give them.
    const asAdmin = await admin.api.brain.read();

    expect({
      added,
      events: events
        .filter(({ action }) => action === "brain.records.added")
        .map(({ actor, provenance, detail }) => ({
          actor: actor.type,
          provenance,
          detail,
        })),
      source: workspace.sources.find(({ id }) => id === ids.source),
      byAnAccountant: asAdmin.sources.find(({ id }) => id === accountants.id)
        ?.who,
      headOfFinanceToAdmin: asAdmin.sources.find(({ id }) => id === ids.source)
        ?.who,
      // The staff list a record names, as where it came from: when it came
      // in, for a member who reads nothing else of the onboarding.
      staffList: workspace.sources.find(({ id }) => id === "src-roster"),
      tool: workspace.tools.find(({ id }) => id === ids.tool),
      candidate: workspace.candidates.find(({ id }) => id === ids.candidate),
      statements: workspace.statements.filter(({ sourceId }) =>
        [ids.source, "src-roster"].includes(sourceId)
      ),
    }).toStrictEqual({
      added: { added: 7, unchanged: 0 },
      events: [
        {
          actor: "person",
          provenance: records.map(({ type, id }) => `${type}:${id}`),
          detail: { added: 7 },
        },
      ],
      byAnAccountant: "Accountant",
      headOfFinanceToAdmin: undefined,
      staffList: {
        id: "src-roster",
        kind: "import",
        connection: "directory",
        title: "Staff list",
        date: new Date().toISOString().slice(0, 10),
        step: 2,
      },
      // The one head of finance's role would point at them: it stays out,
      // for every reader.
      source: {
        id: ids.source,
        kind: "interview",
        title: "Finance interview",
        date: "2026-10-20",
        how: "Live, 45 minutes",
        step: 2,
        interviewee: "stakeholder",
        teamIds: ["team-finance"],
        // One of the brain's own records: an admin may take it out.
        forgettable: true,
      },
      tool: {
        id: ids.tool,
        name: "Exact Online",
        teamIds: ["team-finance"],
        sourceId: ids.source,
        ai: "none",
      },
      candidate: { id: ids.candidate, name: "Invoice entry" },
      // In the order they were added, the earlier one never edited.
      statements: [
        {
          id: ids.blocker,
          kind: "blocker",
          text: "Invoices are typed over by hand.",
          sourceId: ids.source,
          teamIds: ["team-finance"],
          toolIds: [ids.tool],
          candidateId: ids.candidate,
          pain: "high",
        },
        {
          id: ids.followUp,
          kind: "blocker",
          text: "Typing invoices over still takes a day a week.",
          sourceId: ids.source,
          teamIds: ["team-finance"],
          toolIds: [ids.tool],
          candidateId: ids.candidate,
          followsUp: ids.blocker,
          pain: "medium",
        },
        {
          id: ids.wish,
          kind: "wish",
          text: "Clients get their numbers within a week.",
          sourceId: "src-roster",
          teamIds: [],
          toolIds: [],
        },
      ],
    });
  });

  it("are refused to anyone but an admin, keeping nothing", async () => {
    const member = await signedInApi(idp, "user");
    const builder = await signedInApi(idp, "builder");
    const { ids, records } = interview(unique());

    const outcomes = [
      await outcome(member.api.brain.addRecords(records)),
      await outcome(builder.api.brain.addRecords(records)),
    ];
    const workspace = await member.api.brain.read();

    expect({
      outcomes,
      kept: workspace.sources.some(({ id }) => id === ids.source),
    }).toStrictEqual({
      outcomes: ["role.forbidden", "role.forbidden"],
      kept: false,
    });
  });

  it("are never written over: a retry changes nothing, and a different record under a held id keeps none of its call", async () => {
    const admin = await signedInApi(idp, "admin");
    await admin.api.onboarding.saveRoster(roster);
    const { ids, records } = interview(unique());
    await admin.api.brain.addRecords(records);
    const extra = `cand-${unique()}`;

    let retried: unknown;
    const events = await auditedDuring(async () => {
      retried = await admin.api.brain.addRecords(records);
    });
    const rewritten = await outcome(
      admin.api.brain.addRecords([
        { type: "candidate", id: extra, name: "Expense claims" },
        {
          type: "statement",
          id: ids.blocker,
          kind: "blocker",
          text: "It was never a problem.",
          sourceId: ids.source,
        },
      ])
    );
    // An id is one record, whatever type it is sent as.
    const otherType = await outcome(
      admin.api.brain.addRecords([
        { type: "candidate", id: ids.blocker, name: "Typing invoices" },
      ])
    );
    const workspace = await admin.api.brain.read();

    expect({
      retried,
      otherType,
      events: events.filter(({ action }) => action.startsWith("brain.")),
      rewritten,
      blocker: workspace.statements.find(({ id }) => id === ids.blocker)?.text,
      extraKept: workspace.candidates.some(({ id }) => id === extra),
    }).toStrictEqual({
      retried: { added: 0, unchanged: 6 },
      otherType: "brain.record_conflict",
      events: [],
      rewritten: "brain.record_conflict",
      blocker: "Invoices are typed over by hand.",
      extraKept: false,
    });
  });

  it("take a retry racing its first call as unchanged, and write what is still fresh when a racing call took only some ids", async () => {
    const admin = await signedInApi(idp, "admin");
    await admin.api.onboarding.saveRoster(roster);
    const other = await signedInApi(idp, "admin");

    /**
     * Adds `records` as the admin while another admin's call adding
     * `racing` lands between this call's read and its first write.
     */
    const racedBy = async (
      records: BrainRecordInput[],
      racing: BrainRecordInput[]
    ) => {
      const prepare = env.DB.prepare.bind(env.DB);
      const batch = env.DB.batch.bind(env.DB);
      // The batch to race is the first that writes records: background
      // work (an outbox's drain) may batch first.
      let writing = false;
      let raced = false;
      const prepared = vi
        .spyOn(env.DB, "prepare")
        .mockImplementation((query) => {
          writing ||= !raced && query.startsWith('insert into "brain_records"');
          return prepare(query);
        });
      const batched = vi
        .spyOn(env.DB, "batch")
        .mockImplementation(async (statements) => {
          if (writing && !raced) {
            raced = true;
            await other.api.brain.addRecords(racing);
          }
          return await batch(statements);
        });
      try {
        return await admin.api.brain.addRecords(records);
      } finally {
        prepared.mockRestore();
        batched.mockRestore();
      }
    };
    const whole = interview(unique());
    const part = interview(unique());

    expect({
      retry: await racedBy(whole.records, whole.records),
      part: await racedBy(part.records, part.records.slice(0, 1)),
    }).toStrictEqual({
      retry: { added: 0, unchanged: 6 },
      part: { added: 5, unchanged: 1 },
    });
  });

  it("refuse a reference to nothing, a pain on what doesn't hurt, and anything a record doesn't name", async () => {
    const admin = await signedInApi(idp, "admin");
    await admin.api.onboarding.saveRoster(roster);
    const tag = unique();
    const statement = {
      type: "statement",
      id: `st-${tag}`,
      kind: "goal",
      text: "Close the books in three days.",
      sourceId: "src-roster",
    } as const;

    // More than a source holds: its interview's words, which never reach
    // the brain.
    const withTranscript = {
      type: "source" as const,
      id: `src-${tag}`,
      kind: "interview" as const,
      title: "Interview",
      date: "2026-10-20",
      transcript: { turns: [], chapters: [] },
    };

    const outcomes = {
      noSource: await outcome(
        admin.api.brain.addRecords([
          { ...statement, sourceId: `src-${tag}-missing` },
        ])
      ),
      noTool: await outcome(
        admin.api.brain.addRecords([
          { ...statement, toolIds: [`tool-${tag}-missing`] },
        ])
      ),
      noEarlier: await outcome(
        admin.api.brain.addRecords([
          { ...statement, followsUp: `st-${tag}-missing` },
        ])
      ),
      // Each following the other up: neither came before.
      circle: await outcome(
        admin.api.brain.addRecords([
          { ...statement, kind: "blocker", followsUp: `st-${tag}-b` },
          {
            ...statement,
            id: `st-${tag}-b`,
            kind: "blocker",
            followsUp: statement.id,
          },
        ])
      ),
      // The kickoff was never brought in: not a source the brain has.
      noKickoff: await outcome(
        admin.api.brain.addRecords([{ ...statement, sourceId: "src-kickoff" }])
      ),
      painlessGoal: await outcome(
        admin.api.brain.addRecords([{ ...statement, pain: "high" }])
      ),
      transcript: await outcome(admin.api.brain.addRecords([withTranscript])),
      kickoffId: await outcome(
        admin.api.brain.addRecords([
          {
            type: "source",
            id: "src-kickoff",
            kind: "interview",
            title: "Not the kickoff",
            date: "2026-10-20",
          },
        ])
      ),
      // Nor as another type's own id.
      rosterIdTaken: await outcome(
        admin.api.brain.addRecords([
          { type: "candidate", id: "src-roster", name: "Invoice entry" },
        ])
      ),
      tooMany: await outcome(
        admin.api.brain.addRecords(
          Array.from({ length: brainRecordsMaxPerCall + 1 }, (_, index) => ({
            type: "candidate" as const,
            id: `cand-${tag}-${index}`,
            name: "Candidate",
          }))
        )
      ),
    };
    const workspace = await admin.api.brain.read();

    expect({
      outcomes,
      kept: workspace.statements.some(({ id }) => id === statement.id),
    }).toStrictEqual({
      outcomes: {
        noSource: "brain.record_missing",
        noTool: "brain.record_missing",
        noEarlier: "brain.record_missing",
        circle: "brain.record_missing",
        noKickoff: "brain.record_missing",
        painlessGoal: "brain.record_invalid",
        transcript: "brain.record_invalid",
        kickoffId: "brain.record_invalid",
        rosterIdTaken: "brain.record_invalid",
        tooMany: "brain.record_invalid",
      },
      kept: false,
    });
  });

  it("stop at each type's cap", async () => {
    const admin = await signedInApi(idp, "admin");
    await admin.api.onboarding.saveRoster(roster);
    const tag = unique();
    const cap = brainRecordsMaxPerType.candidate;
    const before = await admin.api.brain.read();
    const held = before.candidates.length;
    for (let start = 0; start < cap - held; start += brainRecordsMaxPerCall) {
      const size = Math.min(brainRecordsMaxPerCall, cap - held - start);
      const records = Array.from({ length: size }, (_, index) => ({
        type: "candidate" as const,
        id: `cand-${tag}-${start + index}`,
        name: "Candidate",
      }));
      // oxlint-disable-next-line no-await-in-loop -- one batch after another, to the cap
      await admin.api.brain.addRecords(records);
    }

    const past = await outcome(
      admin.api.brain.addRecords([
        { type: "candidate", id: `cand-${tag}-past`, name: "One too many" },
      ])
    );
    const workspace = await admin.api.brain.read();

    expect({ past, held: workspace.candidates.length }).toStrictEqual({
      past: "brain.records_full",
      held: cap,
    });
  });
});

/** A source naming `name`, a tool and a statement in its words. */
const naming = (tag: string, name: string) => {
  const ids = {
    source: `src-${tag}`,
    tool: `tool-${tag}`,
    statement: `st-${tag}`,
  };
  const records: BrainRecordInput[] = [
    {
      type: "source",
      id: ids.source,
      kind: "interview",
      title: `Interview with ${name}`,
      date: "2026-10-20",
    },
    {
      type: "tool",
      id: ids.tool,
      name: `${name}'s sheet`,
      sourceId: ids.source,
      ai: "none",
    },
    {
      type: "statement",
      id: ids.statement,
      kind: "blocker",
      text: `${name} types invoices over by hand.`,
      sourceId: ids.source,
      toolIds: [ids.tool],
      pain: "high",
    },
  ];
  return { ids, records };
};

describe("a record an earlier release's term purge rewrote", () => {
  it("stays as the purge left it when the same record is sent again", async () => {
    const admin = await signedInApi(idp, "admin");
    const tag = unique();
    const name = `Visser${tag}`;
    const { ids, records } = naming(tag, name);
    await admin.api.brain.addRecords(records);
    // As the purge left it on a deployment: its words rewritten, marked.
    const statement = records.find(({ type }) => type === "statement");
    const purgedText = `${purgedMarker} types invoices over by hand.`;
    await env.DB.prepare(
      "UPDATE brain_records SET body = json_set(body, '$.text', ?), purged_at = ? WHERE id = ? AND type = 'statement'"
    )
      .bind(purgedText, Date.now(), ids.statement)
      .run();

    // The onboarding gives a team's intake again: the same records.
    const again = await admin.api.brain.addRecords(records);
    const read = await admin.api.brain.read();

    expect({
      sent: statement?.type,
      again,
      statement: read.statements.find(({ id }) => id === ids.statement)?.text,
    }).toStrictEqual({
      sent: "statement",
      again: { added: 0, unchanged: 3 },
      statement: purgedText,
    });
  });
});
