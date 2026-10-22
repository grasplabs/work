import type { BrainRecordInput } from "@grasp-os/shared/brain-records";
import {
  brainRecordsMaxPerCall,
  brainRecordsMaxPerType,
} from "@grasp-os/shared/brain-records";
import type { RosterInput } from "@grasp-os/shared/onboarding";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// The Playbook's records (`brain.addRecords`, core's brain-records.ts), as
// an admin adds them and every member reads them in `brain.read`. What
// can go wrong, tried here (the threat note is on GRA-527): someone who
// isn't an admin writing the brain; a record written over, or a retry
// failing; a statement whose source, tool, candidate or earlier statement
// doesn't exist; a record carrying more than it may (a transcript), or a
// pain on what doesn't hurt; a flood past a type's cap; a change kept
// without its audit event, or a call half kept.

const idp = mockIdp();

/** Who works where: what makes the staff list a source the brain has. */
const roster: RosterInput = {
  teams: [{ id: "finance", name: "Finance", lead: null }],
  people: [{ id: "ann", name: "Ann", team: "finance", title: "Accountant" }],
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

describe("the Playbook's records", { timeout: 120_000 }, () => {
  it("are added by an admin, read by every member in the brain, and audited", async () => {
    const admin = await signedInApi(idp, "admin");
    await admin.api.onboarding.saveRoster(roster);
    const member = await signedInApi(idp, "user");
    const { ids, records } = interview(unique());

    let added: unknown;
    const events = await auditedDuring(async () => {
      added = await admin.api.brain.addRecords(records);
    });
    const workspace = await member.api.brain.read();

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
      // The staff list a record names, as where it came from: when it came
      // in, for a member who reads nothing else of the onboarding.
      staffList: workspace.sources.find(({ id }) => id === "src-roster"),
      tool: workspace.tools.find(({ id }) => id === ids.tool),
      candidate: workspace.candidates.find(({ id }) => id === ids.candidate),
      statements: workspace.statements.filter(({ sourceId }) =>
        [ids.source, "src-roster"].includes(sourceId)
      ),
    }).toStrictEqual({
      added: { added: 6, unchanged: 0 },
      events: [
        {
          actor: "person",
          provenance: records.map(({ type, id }) => `${type}:${id}`),
          detail: { added: 6 },
        },
      ],
      staffList: {
        id: "src-roster",
        kind: "import",
        connection: "directory",
        title: "Staff list",
        date: new Date().toISOString().slice(0, 10),
        step: 2,
      },
      source: {
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

  it("take a retry racing its first call as the retry it is", async () => {
    const admin = await signedInApi(idp, "admin");
    await admin.api.onboarding.saveRoster(roster);
    const again = await signedInApi(idp, "admin");
    const { records } = interview(unique());

    const outcomes = await Promise.all([
      admin.api.brain.addRecords(records),
      again.api.brain.addRecords(records),
    ]);

    expect(
      outcomes.map(({ added, unchanged }) => `${added}/${unchanged}`).toSorted()
    ).toStrictEqual(["0/6", "6/0"]);
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
