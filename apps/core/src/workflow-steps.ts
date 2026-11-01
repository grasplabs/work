import type { workflowStepEditSchema } from "@grasp-os/shared/workflow-resources";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import type { z } from "zod";

// One step of a draft edited from the canvas (GRA-514): a change of a
// task's body, or a task inserted into a list of tasks, applied to the
// draft's text as JSON. Pure: the draft saves what it answers as its next
// revision (workflow-drafts.ts, `editWorkflowStep`), checked like any
// edit, so a step the profile refuses is saved with its problems and never
// becomes a checkpoint.
//
// Threat model, and how each is closed:
//
// - Editing anything but a step. A pointer must name a list of tasks (its
//   last token `do`, `try` or `branches`, where the profile keeps them, as
//   the diagram names them) or a task in one: a single-key object in such
//   a list, by its index and ID. Anything else is `workflow.step_not_found`.
// - Prototype keys. The definition is walked by own keys and array
//   indexes only, and a task is written as a new single-key object, so no
//   pointer token or ID reaches an object's prototype.
// - A step changed under someone. The edit names the draft revision it
//   read, and the draft saves it only over that revision.

type StepEdit = z.infer<typeof workflowStepEditSchema>["edit"];

/** The keys under which the profile keeps a list of tasks. */
const taskListKeys: ReadonlySet<string> = new Set(["do", "try", "branches"]);

const notFound = () => workflowResourceErrors.create("workflow.step_not_found");

/** The tokens of JSON Pointer `pointer` (RFC 6901), unescaped. */
const tokensOf = (pointer: string): string[] =>
  pointer
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const indexPattern = /^(?:0|[1-9]\d*)$/u;

/** The array index `token` names, or -1 for none. */
const indexOf = (token: string | undefined): number =>
  token !== undefined && indexPattern.test(token) ? Number(token) : -1;

/** What `tokens` name in `root`, by own keys and indexes only. */
const valueAt = (root: unknown, tokens: readonly string[]): unknown => {
  let value: unknown = root;
  for (const token of tokens) {
    if (Array.isArray(value)) {
      const index = indexOf(token);
      value = index >= 0 && index < value.length ? value[index] : undefined;
    } else if (isObject(value) && Object.hasOwn(value, token)) {
      value = value[token];
    } else {
      return undefined;
    }
  }
  return value;
};

/** The list of tasks `tokens` name in `root`, or `workflow.step_not_found`. */
const taskList = (root: unknown, tokens: readonly string[]): unknown[] => {
  const list = valueAt(root, tokens);
  if (!taskListKeys.has(tokens.at(-1) ?? "") || !Array.isArray(list)) {
    throw notFound();
  }
  return list;
};

/**
 * `source`, the draft's text, with `edit` applied, as the text to save:
 * formatted as JSON with two spaces. Text that isn't JSON is
 * `workflow.draft_not_json`; a pointer to no step or list of tasks,
 * `workflow.step_not_found`.
 */
export const applyStepEdit = (source: string, edit: StepEdit): string => {
  let definition: unknown;
  try {
    definition = JSON.parse(source);
  } catch {
    throw workflowResourceErrors.create("workflow.draft_not_json");
  }
  if (edit.kind === "change") {
    const tokens = tokensOf(edit.pointer);
    const id = tokens.at(-1);
    const index = indexOf(tokens.at(-2));
    const list = taskList(definition, tokens.slice(0, -2));
    const task = list[index];
    if (
      id === undefined ||
      !isObject(task) ||
      Object.keys(task).length !== 1 ||
      !Object.hasOwn(task, id)
    ) {
      throw notFound();
    }
    list[index] = Object.fromEntries([[id, edit.body]]);
  } else {
    const list = taskList(definition, tokensOf(edit.list));
    if (edit.index > list.length) {
      throw notFound();
    }
    list.splice(edit.index, 0, Object.fromEntries([[edit.id, edit.body]]));
  }
  return JSON.stringify(definition, null, 2);
};
