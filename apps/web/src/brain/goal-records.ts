import type { Goal, GoalWorkflow } from "@grasp-os/shared/brain";
import type { BrainRecordInput } from "@grasp-os/shared/brain-records";

// The brain's records an admin's change to the board's goals adds
// (`brain.addRecords`, core's brain-records.ts): a goal as first set, a
// later wording of one, and each workflow linked to one or taken off.
// What an admin sets in Grasp has a source of its own, one a day: sent
// with every change, and kept once (the same record again is left as it
// is), so a day of changes adds one source, not one each.

/** A goal's wording, as an admin writes it. */
export interface GoalWording {
  title: string;
  howWeNotice: string;
}

/** The source of what admins set in Grasp on `day` (an ISO date): one a day. */
export const goalSourceOf = (day: string): BrainRecordInput => ({
  type: "source",
  id: `src-goals-${day}`,
  kind: "document",
  title: "Board goals, as set in Grasp",
  date: day,
  teamIds: [],
});

const sourceIdOf = (day: string): string => `src-goals-${day}`;

/** A wording as the records keep it: trimmed. */
const trimmed = ({ title, howWeNotice }: GoalWording): GoalWording => ({
  title: title.trim(),
  howWeNotice: howWeNotice.trim(),
});

/** The records that set a new goal, worded `wording`, on `day`. */
export const newGoalRecords = (
  wording: GoalWording,
  day: string,
  id = `goal-${crypto.randomUUID()}`
): BrainRecordInput[] => [
  goalSourceOf(day),
  {
    type: "goal",
    id,
    ...trimmed(wording),
    sourceId: sourceIdOf(day),
    date: day,
  },
];

/** The records that word goal `goalId` again, as `wording`, on `day`. */
export const rewordedRecords = (
  goalId: string,
  wording: GoalWording,
  day: string
): BrainRecordInput[] => [
  goalSourceOf(day),
  {
    type: "goalVersion",
    id: `goalv-${crypto.randomUUID()}`,
    goalId,
    ...trimmed(wording),
    sourceId: sourceIdOf(day),
    date: day,
  },
];

const keyOf = ({ app, workflow }: GoalWorkflow): string => `${app}/${workflow}`;

/**
 * The records that make `chosen` the workflows linked to `goal` on `day`:
 * a link for each newly chosen, a taking off for each no longer chosen.
 * None when nothing changed.
 */
export const relinkedRecords = (
  goal: Goal,
  chosen: readonly GoalWorkflow[],
  day: string
): BrainRecordInput[] => {
  const before = new Set(goal.workflows.map(keyOf));
  const after = new Set(chosen.map(keyOf));
  const link = (
    { app, workflow }: GoalWorkflow,
    linked: boolean
  ): BrainRecordInput => ({
    type: "goalLink",
    id: `goall-${crypto.randomUUID()}`,
    goalId: goal.id,
    app,
    workflow,
    linked,
    date: day,
  });
  return [
    ...chosen
      .filter((each) => !before.has(keyOf(each)))
      .map((each) => link(each, true)),
    ...goal.workflows
      .filter((each) => !after.has(keyOf(each)))
      .map((each) => link(each, false)),
  ];
};
