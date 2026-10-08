import type {
  Checker,
  FunctionCall,
  ListRecord,
  TaskRecord,
  Transition,
} from "./checker.ts";
import { profileLimits } from "./limits.ts";

/**
 * Control flow, checked over the whole definition once the walk has
 * recorded every list. A named transition must target a strictly later
 * sibling, so the transitions of one list can't form a cycle, and the
 * check is one comparison each. What remains are cycles through reusable
 * functions, found by one depth-first pass over the call graph: linear in
 * calls, never an enumeration of paths.
 */

const directives = new Set(["continue", "exit", "end"]);

/** Whether a task, when done, continues to its next sibling by itself. */
const fallsThrough = (task: TaskRecord): boolean => {
  if (task.kind === "switch") {
    return false;
  }
  // A raise with no condition never completes; one with `if` may be skipped.
  if (task.kind === "raise" && !task.hasIf) {
    return false;
  }
  // A catch whose then is continue moves on to the next sibling on the
  // error path, whatever the try's own then; without one, the error path
  // follows the try's then.
  if (task.catchNext?.target === "continue") {
    return true;
  }
  return task.next === undefined || task.next.target === "continue";
};

/** Where `continue` leads from `position`: the next sibling, if any. */
const continueTarget = (
  list: ListRecord,
  position: number
): number | undefined =>
  position + 1 < list.tasks.length ? position + 1 : undefined;

const checkList = (checker: Checker, list: ListRecord): void => {
  const positions = new Map<string, number>();
  for (const [position, task] of list.tasks.entries()) {
    positions.set(task.id, position);
  }
  /** The position a transition leads to; `undefined` for a directive or an error. */
  const resolve = (
    task: TaskRecord,
    position: number,
    transition: Transition
  ): number | undefined => {
    const where = { pointer: transition.pointer, taskId: task.id };
    if (directives.has(transition.target)) {
      return undefined;
    }
    if (!list.namedTransitions) {
      checker.report.error(
        "flow.not_allowed",
        where,
        "Fork branches are separate scopes: use continue, exit or end here.",
        { expected: "continue, exit or end" }
      );
      return undefined;
    }
    const target = positions.get(transition.target);
    if (target === undefined) {
      checker.report.error(
        "flow.unknown_target",
        where,
        "Name a later task in the same list, or use continue, exit or end.",
        {
          reason: checker.taskIds.has(transition.target)
            ? "the task is in another scope"
            : "no task has that ID",
        }
      );
      return undefined;
    }
    if (target <= position) {
      checker.report.error(
        "flow.backward_transition",
        where,
        "Jump only forward; repeat work with a bounded for loop."
      );
      return undefined;
    }
    return target;
  };

  // Runs of tasks joined by falling through: a branch entered at one task
  // of a run continues into every later task of it.
  const runs: number[] = [];
  let run = 0;
  for (const task of list.tasks) {
    runs.push(run);
    if (!fallsThrough(task)) {
      run += 1;
    }
  }

  for (const [position, task] of list.tasks.entries()) {
    if (task.next !== undefined) {
      resolve(task, position, task.next);
    }
    if (task.catchNext !== undefined) {
      resolve(task, position, task.catchNext);
    }
    if (task.cases === undefined) {
      continue;
    }
    // Two branches of one switch entering the same run: the earlier one
    // falls through into the later instead of joining explicitly.
    const branchByRun = new Map<number, number>();
    for (const switchCase of task.cases) {
      // `continue` enters the next sibling like any named target; `exit`
      // and `end` leave the list.
      const target =
        switchCase.next.target === "continue"
          ? continueTarget(list, position)
          : resolve(task, position, switchCase.next);
      if (target === undefined) {
        continue;
      }
      const targetRun = runs[target] ?? -1;
      const earlier = branchByRun.get(targetRun);
      if (earlier !== undefined && earlier !== target) {
        checker.report.error(
          "flow.switch_fallthrough",
          { pointer: switchCase.next.pointer, taskId: task.id },
          "End each branch with then: the join task, exit or end, so it can't run into another branch."
        );
        continue;
      }
      branchByRun.set(targetRun, target);
    }
  }
};

/**
 * Cycles among reusable functions: a function that calls itself, directly
 * or through others. One iterative depth-first pass, each call once.
 */
const checkFunctionCycles = (checker: Checker): void => {
  const calls = new Map<string, FunctionCall[]>();
  for (const call of checker.functionCalls) {
    if (call.from === undefined) {
      continue;
    }
    const from = calls.get(call.from) ?? [];
    from.push(call);
    calls.set(call.from, from);
  }
  const state = new Map<string, "active" | "done">();
  for (const start of calls.keys()) {
    if (state.has(start)) {
      continue;
    }
    const stack: { name: string; next: number }[] = [{ name: start, next: 0 }];
    state.set(start, "active");
    while (stack.length > 0) {
      const frame = stack.at(-1);
      if (frame === undefined) {
        break;
      }
      const call = calls.get(frame.name)?.[frame.next];
      if (call === undefined) {
        state.set(frame.name, "done");
        stack.pop();
        continue;
      }
      frame.next += 1;
      const seen = state.get(call.to);
      if (seen === "active") {
        checker.report.error(
          "flow.cycle",
          { pointer: call.pointer, taskId: call.taskId },
          "Reusable functions can't call themselves, directly or through others."
        );
      } else if (seen === undefined) {
        state.set(call.to, "active");
        stack.push({ name: call.to, next: 0 });
      }
    }
  }
};

/**
 * Scopes across calls: a reusable function's body runs inside the task
 * that calls it, so a chain of calls nests as deep as its bodies together.
 * Each function's reach (its own deepest task, or a call in it plus its
 * callee's reach) is computed once, so the pass is linear in calls; a
 * call that would take its body past 16 scopes is refused where it is.
 */
const checkCallDepth = (checker: Checker): void => {
  const own = new Map<string, number>();
  for (const task of checker.tasks) {
    const [root] = task.scope;
    if (root !== undefined && checker.functions.has(root)) {
      own.set(root, Math.max(own.get(root) ?? 0, task.scope.length));
    }
  }
  const callsFrom = new Map<string, FunctionCall[]>();
  for (const call of checker.functionCalls) {
    if (call.from !== undefined) {
      callsFrom.set(call.from, [...(callsFrom.get(call.from) ?? []), call]);
    }
  }
  const reach = new Map<string, number>();
  // A cycle is refused by checkFunctionCycles; here it just ends the walk.
  const visiting = new Set<string>();
  const reachOf = (name: string): number => {
    const known = reach.get(name);
    if (known !== undefined) {
      return known;
    }
    if (visiting.has(name)) {
      return 0;
    }
    visiting.add(name);
    let deepest = own.get(name) ?? 1;
    for (const call of callsFrom.get(name) ?? []) {
      deepest = Math.max(deepest, call.depth + reachOf(call.to));
    }
    visiting.delete(name);
    reach.set(name, deepest);
    return deepest;
  };
  for (const call of checker.functionCalls) {
    if (call.depth + reachOf(call.to) > profileLimits.maxScopes) {
      checker.report.error(
        "task.scope_too_deep",
        { pointer: call.pointer, taskId: call.taskId },
        "Calls nest the called function's tasks: keep them within 16 scopes, or use a child workflow."
      );
    }
  }
};

export const checkFlow = (checker: Checker): void => {
  for (const list of checker.lists) {
    checkList(checker, list);
  }
  checkFunctionCycles(checker);
  checkCallDepth(checker);
};
