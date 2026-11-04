import type { LoadedBuild } from "../workflow-builds.ts";
import { generatedForRunHost } from "./sealed-run.ts";

// The engine steps a run of a sealed build runs on the run host
// (sealed-run.ts), as what reads its journal (its waits, run-waits.ts; its
// trace, resource-run-trace.ts) places them: by its build's own table of
// tasks, never by what a name merely looks like.
//
// The SDK runs step `name` with key `key` as `name:encodeURIComponent(key)`
// (@grasp-os/sdk/workflow), and the generated code names each step of a
// task by the task's ID and the kind of step it is (`SealedTask.steps`:
// `task`, `enter`, `leave`, `item` or `catch`), inside a loop's items
// with each loop's index after `@`, outermost first (`kind@i1/i2`), a
// loop's own `item` step with its own loop's index last. A
// decision's own steps follow its task step after `#` (`#ask`, `#asked`,
// `#answer`, …), the SDK's. The run host refuses a step by any other name,
// or any other encoding of the same one.

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
   * The loop item it runs in, `<for>.<index>` for each loop around it,
   * joined by `/`; null outside loops.
   */
  readonly item: string | null;
  /** A decision's own step past the task's (`#ask`, …); "" for its own. */
  readonly part: string;
}

/**
 * An engine step of a task: its ID, its kind, each loop's index (`@`, `/`
 * encoded as the SDK encodes a key), and a decision's own step past it.
 */
const engineStep =
  /^(?<task>[a-z][a-z0-9]*(?:-[a-z0-9]+)*):(?<kind>[a-z]+)(?:%40(?<items>(?:0|[1-9]\d*)(?:%2F(?:0|[1-9]\d*))*))?(?<part>#[a-z]+(?:-[a-z]+)*)?$/u;

/**
 * The tasks of `build` by ID, as their steps' names place them; undefined
 * for a build not generated for the run host, whose steps are named
 * otherwise (resource-host.ts) until GRA-1366 removes it.
 */
export const sealedStepsOf = (build: LoadedBuild): SealedSteps | undefined =>
  generatedForRunHost(build)
    ? new Map(build.tasks.map((task) => [task.id, task]))
    : undefined;

/**
 * Engine step `name` as `steps`, its run's build's tasks, place it: a
 * step its task has, in an item of each loop around it (and of its own,
 * for a loop's `item` step); undefined for any other name.
 */
export const sealedStepOf = (
  name: string,
  steps: SealedSteps
): SealedStep | undefined => {
  const named = engineStep.exec(name)?.groups;
  const task = named?.task === undefined ? undefined : steps.get(named.task);
  if (
    named?.task === undefined ||
    named.kind === undefined ||
    task === undefined ||
    !task.steps.includes(named.kind)
  ) {
    return undefined;
  }
  // A loop's `item` step runs in an item of its own loop too.
  const loops =
    named.kind === "item" ? [...task.scope, named.task] : task.scope;
  const indices = named.items?.split("%2F") ?? [];
  if (indices.length !== loops.length) {
    return undefined;
  }
  return {
    task: named.task,
    kind: named.kind,
    item:
      indices.length === 0
        ? null
        : loops.map((loop, at) => `${loop}.${indices[at] ?? ""}`).join("/"),
    part: named.part ?? "",
  };
};
