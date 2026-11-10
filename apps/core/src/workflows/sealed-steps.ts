import type { LoadedBuild } from "../workflow-builds.ts";

// The engine steps a run of a sealed build runs on the run host
// (sealed-run.ts), as what reads its journal (its waits, run-waits.ts; its
// trace, resource-run-trace.ts) places them: by its build's own table of
// tasks, never by what a name merely looks like.
//
// The SDK's journal (@grasp-os/sdk's workflow-journal.ts) names each step
// of a task by the task's ID and the part of it it is (`SealedTask.steps`:
// `enter` or `task`), and from the task's second run on, which only a
// task inside a loop's items has, its count of earlier runs after `@`
// (`book:task@2`). A decision's own steps follow its task step after `#`
// (`#ask`, `#asked`, `#answer`). The run host refuses a step by any other
// name.

/** A task of a sealed build, as its steps' names place it (`SealedTask`). */
export interface StepTask {
  readonly steps: readonly string[];
  readonly scope: readonly string[];
}

/** A sealed build's tasks by ID, as their steps' names place them. */
export type SealedSteps = ReadonlyMap<string, StepTask>;

/** An engine step of a sealed run's task, as its name places it. */
export interface SealedStep {
  /** The task's ID. */
  readonly task: string;
  /** Which of its steps (`SealedTask.steps`). */
  readonly kind: string;
  /**
   * Which run of the task it is, from 0, for a task inside a loop's
   * items; null for any other, which runs at most once.
   */
  readonly item: string | null;
  /** A decision's own step past the task's (`#ask`, …); "" for its own. */
  readonly part: string;
}

/**
 * An engine step of a task: its ID, its part, its run's count from its
 * second on, and a decision's own step past it.
 */
const engineStep =
  /^(?<task>[a-z][A-Za-z0-9]{0,63}):(?<kind>[a-z]+)(?:@(?<count>[1-9]\d{0,8}))?(?<part>#[a-z]+(?:-[a-z]+)*)?$/u;

/**
 * Engine step `name` read: its task, its part, its run's count (0 for a
 * name without one) and a decision's own step; nothing for any other
 * form.
 */
export const engineStepOf = (
  name: string
):
  | {
      readonly task: string;
      readonly kind: string;
      readonly count: number;
      readonly part: string;
    }
  | undefined => {
  const named = engineStep.exec(name)?.groups;
  if (named?.task === undefined || named.kind === undefined) {
    return undefined;
  }
  return {
    task: named.task,
    kind: named.kind,
    count: named.count === undefined ? 0 : Number(named.count),
    part: named.part ?? "",
  };
};

/** The tasks of `build` by ID, as their steps' names place them. */
export const sealedStepsOf = (build: LoadedBuild): SealedSteps =>
  new Map(build.tasks.map((task) => [task.id, task]));

/**
 * Engine step `name` as `steps`, its run's build's tasks, place it: a
 * step its task has, run again (`@<count>`) only where its task is inside
 * a loop's items; undefined for any other name.
 */
export const sealedStepOf = (
  name: string,
  steps: SealedSteps
): SealedStep | undefined => {
  const named = engineStepOf(name);
  const task = named === undefined ? undefined : steps.get(named.task);
  if (
    named === undefined ||
    task === undefined ||
    !task.steps.includes(named.kind) ||
    (named.count > 0 && task.scope.length === 0)
  ) {
    return undefined;
  }
  return {
    task: named.task,
    kind: named.kind,
    item: task.scope.length === 0 ? null : String(named.count),
    part: named.part,
  };
};
