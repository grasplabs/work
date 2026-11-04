import type {
  DiagramScope,
  DiagramTask,
  WorkflowDiagram,
} from "@grasp-os/shared/workflow-diagrams";
import { checkWorkflow } from "@grasp-os/workflow-schema/check";
import { stepListsOf } from "@grasp-os/workflow-schema/format";
import type { Step } from "@grasp-os/workflow-schema/format";

// A workflow's diagram, drawn from its checked grasp-workflow/1 document:
// each step by its stable ID, in order, with every list of steps it holds,
// whether a run takes it or not. It reads the document's structure only:
// nothing is evaluated, and what a step says through an expression is
// never shown as a value. Titles are display text. Text that doesn't pass
// the format draws an empty diagram: only a checkpoint, which passed, or
// a published version is ever drawn.

/** What a step does, as its literal fields say it. */
const detailOf = (step: Step): string | null => {
  if (step.type === "do") {
    return step.operation === undefined
      ? step.binding
      : `${step.binding} · ${step.operation}`;
  }
  if (step.type === "agent") {
    return step.binding;
  }
  if (step.type === "wait") {
    return "for" in step ? step.for : null;
  }
  if (step.type === "raise") {
    return step.error.title ?? step.error.type;
  }
  return null;
};

/** A list a step holds, by its path, as the diagram names its scope. */
const scopeKinds = new Map<string, DiagramScope["kind"]>([
  ["then", "then"],
  ["else", "else"],
  ["try", "try"],
  ["catch/do", "catch"],
]);

const tasksOf = (steps: readonly Step[], pointer: string): DiagramTask[] =>
  steps.map((step, index) => {
    const at = `${pointer}/${index}`;
    return {
      id: step.id,
      pointer: at,
      kind: step.type,
      label: step.title ?? null,
      detail: detailOf(step),
      guarded: step.if !== undefined,
      next: { kind: "continue" },
      scopes: stepListsOf(step).flatMap(({ path, steps: inner }) => {
        const kind = scopeKinds.get(path);
        return kind === undefined
          ? []
          : [
              {
                kind,
                name: null,
                guarded: false,
                next: null,
                tasks: tasksOf(inner, `${at}/${path}`),
              },
            ];
      }),
    };
  });

/** The diagram of `source`, a workflow's document as text. */
export const workflowDiagram = (source: string): WorkflowDiagram => {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    return { tasks: [] };
  }
  const checked = checkWorkflow(json);
  return checked.ok
    ? { tasks: tasksOf(checked.workflow.document.steps, "/steps") }
    : { tasks: [] };
};
