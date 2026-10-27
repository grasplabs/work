import type { BrainRecordInput } from "@grasp-os/shared/brain-records";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// The board's goals (GRA-516), kept as the brain's records (`goal`,
// `goalVersion`, `goalLink`) and read by every member in `brain.goals`
// and `brain.read`. What can go wrong, tried here: someone who isn't an
// admin setting or changing a goal; a goal written over, rather than
// worded again; a wording or link for a goal that doesn't exist, or a link
// to a workflow the company doesn't have; a goal that names an App, or a
// workflow, its reader couldn't open; a link taken off still showing; a
// change kept without its audit event, or a refused call kept in part.

const idp = mockIdp();

/** Signing people in and building Apps can be slow on CI. */
const slow = { timeout: 60_000 };

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** A goal's records, under ids no other test uses: its source, and it as first set. */
const goalSet = (tag: string) => {
  const ids = { source: `src-board-${tag}`, goal: `goal-${tag}` };
  const goal = {
    type: "goal",
    id: ids.goal,
    title: "Close the books in three days",
    howWeNotice: "The month closes by the third working day.",
    sourceId: ids.source,
    date: "2026-10-01",
  } as const;
  const records: BrainRecordInput[] = [
    {
      type: "source",
      id: ids.source,
      kind: "document",
      title: "Board plan 2027",
      date: "2026-10-01",
      teamIds: [],
    },
    goal,
  ];
  return { ids, goal, records };
};

/** A link of `workflow` in `app` to `goal`, or its taking off. */
const link = (
  goal: string,
  app: string,
  workflow: string,
  linked = true
): BrainRecordInput => ({
  type: "goalLink",
  id: `link-${unique()}`,
  goalId: goal,
  app,
  workflow,
  linked,
  date: "2026-10-20",
});

/** `person`'s view of goal `id`: its wordings' titles and its workflows. */
const goalAs = async (person: Person, id: string) => {
  const goals = await person.api.brain.goals();
  const goal = goals.find((each) => each.id === id);
  return goal === undefined
    ? undefined
    : {
        titles: goal.versions.map(({ title }) => title),
        workflows: goal.workflows.map(
          ({ app, workflow }) => `${app}/${workflow}`
        ),
      };
};

describe("the board's goals", slow, () => {
  it("are set and worded again by an admin, link the workflows that serve them, and read for every member as far as they may see each workflow", async () => {
    const [admin, builder, user, outsider] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "builder"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const app = await appWith(builder, {
      ...workflowFiles("chase", "  return 1;"),
      ...workflowFiles("remind", "  return 1;"),
    });
    await builder.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const { ids, records } = goalSet(unique());
    const audited = await auditedDuring(
      async () =>
        await admin.api.brain.addRecords([
          ...records,
          {
            type: "goalVersion",
            id: `${ids.goal}-v2`,
            goalId: ids.goal,
            title: "Close the books in two days",
            howWeNotice: "The month closes by the second working day.",
            sourceId: ids.source,
            date: "2026-10-15",
          },
          link(ids.goal, app, "chase"),
          link(ids.goal, app, "remind"),
          // Taken off again: the newest for a workflow counts.
          link(ids.goal, app, "remind", false),
        ])
    );
    // Linked again later: it counts once, last.
    await admin.api.brain.addRecords([
      link(ids.goal, app, "remind"),
      link(ids.goal, app, "chase", false),
      link(ids.goal, app, "chase"),
    ]);
    const workspace = await user.api.brain.read();
    const inRead = workspace.goals.find(({ id }) => id === ids.goal);

    expect({
      user: await goalAs(user, ids.goal),
      // A member who can't open the App reads the goal, never its workflows.
      outsider: await goalAs(outsider, ids.goal),
      builder: await goalAs(builder, ids.goal),
      // `brain.read` gives the same goal, with its wordings' sources.
      read: inRead?.versions.map(({ sourceId, date }) => [sourceId, date]),
      readWorkflows: inRead?.workflows.length,
      readSource: workspace.sources.some(({ id }) => id === ids.source),
      audited: audited.map(({ action, actor, provenance }) => ({
        action,
        actor: actor.type === "person" ? actor.userId : actor.type,
        records: provenance?.filter((key) => key.startsWith("goal")).length,
      })),
    }).toStrictEqual({
      user: {
        titles: [
          "Close the books in three days",
          "Close the books in two days",
        ],
        workflows: [`${app}/remind`, `${app}/chase`],
      },
      outsider: {
        titles: [
          "Close the books in three days",
          "Close the books in two days",
        ],
        workflows: [],
      },
      builder: {
        titles: [
          "Close the books in three days",
          "Close the books in two days",
        ],
        workflows: [`${app}/remind`, `${app}/chase`],
      },
      read: [
        [ids.source, "2026-10-01"],
        [ids.source, "2026-10-15"],
      ],
      readWorkflows: 2,
      readSource: true,
      // One event for the call, naming each record by its key.
      audited: [
        { action: "brain.records.added", actor: admin.userId, records: 5 },
      ],
    });
  });

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

  it("are refused, whole, to anyone but an admin, over a goal held differently, and for what doesn't exist", async () => {
    const [admin, builder] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "builder"),
    ]);
    const app = await appWith(builder, {
      ...workflowFiles("chase", "  return 1;"),
    });
    const { ids, goal, records } = goalSet(unique());
    await admin.api.brain.addRecords(records);
    const refused = {
      builder: await outcome(
        builder.api.brain.addRecords([link(ids.goal, app, "chase")])
      ),
      // Worded again under its own id: a goal is never written over.
      rewritten: await outcome(
        admin.api.brain.addRecords([{ ...goal, title: "Something else" }])
      ),
      // Each refused call holds a link that would be fine: none of it is kept.
      noGoal: await outcome(
        admin.api.brain.addRecords([
          link(ids.goal, app, "chase"),
          {
            type: "goalVersion",
            id: `v-${unique()}`,
            goalId: `goal-${unique()}`,
            title: "Nobody set this",
            howWeNotice: "",
            sourceId: ids.source,
            date: "2026-10-02",
          },
        ])
      ),
      noSource: await outcome(
        admin.api.brain.addRecords([
          link(ids.goal, app, "chase"),
          {
            type: "goal",
            id: `goal-${unique()}`,
            title: "From nowhere",
            howWeNotice: "",
            sourceId: `src-${unique()}`,
            date: "2026-10-02",
          },
        ])
      ),
      noWorkflow: await outcome(
        admin.api.brain.addRecords([
          link(ids.goal, app, "chase"),
          link(ids.goal, app, "missing"),
        ])
      ),
      noApp: await outcome(
        admin.api.brain.addRecords([
          link(ids.goal, app, "chase"),
          link(ids.goal, `app-${unique()}`, "chase"),
        ])
      ),
      notAGoal: await outcome(
        admin.api.brain.addRecords([link(ids.source, app, "chase")])
      ),
    };
    expect({
      refused,
      kept: await goalAs(admin, ids.goal),
    }).toStrictEqual({
      refused: {
        builder: "role.forbidden",
        rewritten: "brain.record_conflict",
        noGoal: "brain.record_missing",
        noSource: "brain.record_missing",
        noWorkflow: "brain.record_missing",
        noApp: "brain.record_missing",
        notAGoal: "brain.record_missing",
      },
      kept: { titles: ["Close the books in three days"], workflows: [] },
    });
  });
});
