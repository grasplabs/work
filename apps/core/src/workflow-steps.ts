import { isRecord } from "@grasp-os/shared/json";
import type { workflowStepEditSchema } from "@grasp-os/shared/workflow-resources";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { stepListPaths } from "@grasp-os/workflow-schema/format";
import type { z } from "zod";

// One step of a draft edited on the canvas or by the agent (GRA-514): a
// change of a step's fields, or a step inserted into a list of steps,
// applied to the draft's grasp-workflow/2 text as JSON. Pure: the draft
// saves what it answers as its next revision (workflow-editor.ts,
// `editWorkflowStep`), checked like any edit, so a step the format refuses
// is saved with its problems and never becomes a checkpoint.
//
// Threat model, and how each is closed:
//
// - Editing anything but a step. A pointer must name the workflow's own
//   list of steps (`/steps`), a list a step holds under one of its type's
//   list paths (`stepListPaths`: `then`, `else`, `try`, `catch/do`), or a
//   step in such a list, by its index. Anything else is
//   `workflow.step_not_found`.
// - Changing a step's identity. A change keeps the ID the step has, whatever
//   the edit says: IDs are stable keys (an expression reads `<id>`), renamed by `title`.
// - Prototype keys. The document is walked by own keys and array indexes
//   only, and a step is written as a new object, so no pointer token or
//   field reaches an object's prototype.
// - A step changed under someone. The edit names the draft revision it
//   read, and the draft saves it only over that revision.

type StepEdit = z.infer<typeof workflowStepEditSchema>["edit"];

const notFound = () => workflowResourceErrors.create("workflow.step_not_found");

/** The tokens of JSON Pointer `pointer` (RFC 6901), unescaped. */
const tokensOf = (pointer: string): string[] =>
  pointer
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));

type JsonRecord = Record<string, unknown>;

const indexPattern = /^(?:0|[1-9]\d*)$/u;

/** The array index `token` names, or -1 for none. */
const indexOf = (token: string | undefined): number =>
  token !== undefined && indexPattern.test(token) ? Number(token) : -1;

/** A step's own value at `key`, by an own key only. */
const own = (value: JsonRecord, key: string): unknown =>
  Object.hasOwn(value, key) ? value[key] : undefined;

/** The list paths a step of `type` may hold, none for a type there's no such. */
const listPathsOf = (type: unknown): readonly string[] =>
  Object.entries(stepListPaths).find(([each]) => each === type)?.[1] ?? [];

/**
 * The list of steps at `path` in `step`, created empty when its type may
 * hold it and it holds none yet (an `if`'s first `else` step, say).
 */
const listIn = (step: JsonRecord, path: string): unknown[] => {
  if (!listPathsOf(own(step, "type")).includes(path)) {
    throw notFound();
  }
  const [first, second] = path.split("/");
  let holder: JsonRecord = step;
  let key = first ?? "";
  if (second !== undefined) {
    const inner = own(step, key) ?? {};
    if (!isRecord(inner)) {
      throw notFound();
    }
    step[key] = inner;
    holder = inner;
    key = second;
  }
  const list = own(holder, key) ?? [];
  if (!Array.isArray(list)) {
    throw notFound();
  }
  holder[key] = list;
  return list;
};

/**
 * The list of steps `tokens` name in `document`: `["steps"]`, or a step's
 * tokens then one of its list paths' (`then`, or `catch`, `do`).
 */
const walk = (document: JsonRecord, tokens: readonly string[]): unknown[] => {
  if (tokens.length === 1 && tokens[0] === "steps") {
    const list = own(document, "steps");
    if (!Array.isArray(list)) {
      throw notFound();
    }
    return list;
  }
  // A list path is one token, or two (`catch/do`).
  for (const size of [1, 2]) {
    const path = tokens.slice(-size).join("/");
    const holder = tokens.slice(0, -size);
    if (holder.length >= 2 && indexOf(holder.at(-1)) >= 0) {
      const step = walk(document, holder.slice(0, -1))[indexOf(holder.at(-1))];
      if (isRecord(step) && listPathsOf(own(step, "type")).includes(path)) {
        return listIn(step, path);
      }
    }
  }
  throw notFound();
};

/** `fields` as a step with ID `id`: its ID first, any other `id` dropped. */
const stepOf = (id: string, fields: Record<string, unknown>): JsonRecord =>
  Object.fromEntries([
    ["id", id],
    ...Object.entries(fields).filter(([key]) => key !== "id"),
  ]);

/**
 * `source`, the draft's text, with `edit` applied, as the text to save:
 * formatted as JSON with two spaces. Text that isn't a JSON object is
 * `workflow.draft_not_json`; a pointer to no step or list of steps,
 * `workflow.step_not_found`.
 */
export const applyStepEdit = (source: string, edit: StepEdit): string => {
  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch {
    throw workflowResourceErrors.create("workflow.draft_not_json");
  }
  if (!isRecord(document)) {
    throw workflowResourceErrors.create("workflow.draft_not_json");
  }
  if (edit.kind === "change") {
    const tokens = tokensOf(edit.pointer);
    const list = walk(document, tokens.slice(0, -1));
    const index = indexOf(tokens.at(-1));
    const step = list[index];
    const id = isRecord(step) ? own(step, "id") : undefined;
    if (typeof id !== "string") {
      throw notFound();
    }
    list[index] = stepOf(id, edit.step);
  } else {
    const list = walk(document, tokensOf(edit.list));
    if (edit.index > list.length) {
      throw notFound();
    }
    list.splice(edit.index, 0, stepOf(edit.id, edit.step));
  }
  return JSON.stringify(document, null, 2);
};
