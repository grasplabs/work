import type { BrainRecordInput } from "@grasp-os/shared/brain-records";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// The board's goals (GRA-516), kept as the brain's records (`goal`,
// `goalVersion`, `goalLink`) and read by every member in `brain.goals`
// and `brain.read`. What can go wrong, tried here: someone who isn't an
// admin setting or changing a goal; a goal written over, rather than
// worded again; a wording or link for a goal that doesn't exist, or a link
// to a workflow the company doesn't have; a goal that names a workflow
// its reader couldn't open; a link taken off still showing; a
// change kept without its audit event, or a refused call kept in part.

const idp = mockIdp();

/** Signing people in and building Apps can be slow on CI. */
const slow = { timeout: 60_000 };

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** `person`'s view of goal `id`: its wordings' titles and its workflows. */
const goalAs = async (person: Person, id: string) => {
  const goals = await person.api.brain.goals();
  const goal = goals.find((each) => each.id === id);
  return goal === undefined
    ? undefined
    : {
        titles: goal.versions.map(({ title }) => title),
        workflows: goal.workflows,
      };
};

describe("the board's goals", slow, () => {
  it("take the same day's source with every change, kept once, and refuse a member's", async () => {
    const [admin, member] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const day = "2026-10-27";
    const source: BrainRecordInput = {
      type: "source",
      id: `src-goals-${unique()}`,
      kind: "document",
      title: "Board goals, as set in Grasp",
      date: day,
      teamIds: [],
    };
    const goalId = `goal-${unique()}`;
    const wording = {
      title: "Answer every customer within a day",
      howWeNotice: "",
      sourceId: source.id,
      date: day,
    };
    const set = await admin.api.brain.addRecords([
      source,
      { type: "goal", id: goalId, ...wording },
    ]);
    const reworded = await admin.api.brain.addRecords([
      source,
      {
        type: "goalVersion",
        id: `goalv-${unique()}`,
        goalId,
        ...wording,
        title: "Answer every customer within four hours",
      },
    ]);
    const refused = await outcome(
      member.api.brain.addRecords([
        source,
        {
          type: "goalVersion",
          id: `goalv-${unique()}`,
          goalId,
          ...wording,
          title: "Answer whenever",
        },
      ])
    );
    expect({
      set,
      reworded,
      refused,
      read: await goalAs(member, goalId),
    }).toStrictEqual({
      set: { added: 2, unchanged: 0 },
      // The source again, exactly so, is left as it is.
      reworded: { added: 1, unchanged: 1 },
      refused: "role.forbidden",
      read: {
        titles: [
          "Answer every customer within a day",
          "Answer every customer within four hours",
        ],
        workflows: [],
      },
    });
  });

  it("link the company's independent workflows, each shown only to those with a role in it, and refuse one there isn't", async () => {
    const [admin, builder, member] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "builder"),
      signedInApi(idp, "user"),
    ]);
    const day = "2026-10-28";
    const source: BrainRecordInput = {
      type: "source",
      id: `src-goals-${unique()}`,
      kind: "document",
      title: "Board goals, as set in Grasp",
      date: day,
      teamIds: [],
    };
    const goalId = `goal-${unique()}`;
    const [shared, own] = await Promise.all([
      admin.api.workflowResources.create(`chase-${unique()}`),
      builder.api.workflowResources.create(`remind-${unique()}`),
    ]);
    const link = (workflow: string, linked: boolean): BrainRecordInput => ({
      type: "goalLink",
      id: `goall-${unique()}`,
      goalId,
      workflow,
      linked,
      date: day,
    });
    await admin.api.brain.addRecords([
      source,
      {
        type: "goal",
        id: goalId,
        title: "Get paid within a month",
        howWeNotice: "",
        sourceId: source.id,
        date: day,
      },
      link(shared.id, true),
      link(own.id, true),
    ]);
    const missing = await outcome(
      admin.api.brain.addRecords([source, link(`gone-${unique()}`, true)])
    );
    // Taken off again: the newest link counts.
    await admin.api.brain.addRecords([source, link(own.id, false)]);
    const afterOff = await goalAs(admin, goalId);
    await admin.api.brain.addRecords([source, link(own.id, true)]);
    const [asAdmin, asBuilder, asMember] = await Promise.all([
      goalAs(admin, goalId),
      goalAs(builder, goalId),
      goalAs(member, goalId),
    ]);
    expect({
      missing,
      afterOff: afterOff?.workflows,
      admin: asAdmin?.workflows,
      builder: asBuilder?.workflows,
      // A member with a role in neither sees the goal, not its workflows.
      member: asMember?.workflows,
    }).toStrictEqual({
      missing: "brain.record_missing",
      afterOff: [shared.id],
      admin: [shared.id, own.id],
      builder: [own.id],
      member: [],
    });
  });
});
