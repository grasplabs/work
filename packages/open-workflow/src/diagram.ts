import type {
  DiagramNext,
  DiagramScope,
  DiagramTask,
  WorkflowDiagram,
} from "@grasp-os/shared/workflow-diagrams";

import { pointerJoin } from "./diagnostics.ts";
import { isObject } from "./json-text.ts";
import type { JsonObject, JsonValue } from "./json-text.ts";

// A workflow's diagram, drawn from its checked definition (13.10): each
// task by its stable ID, in declaration order, with every scope it holds
// and every case and branch it declares, whether a run takes it or not.
// It reads the definition's structure only: nothing is evaluated, and
// what source says through an expression is shown as an expression, never
// as a value. Labels and positions (`metadata.grasp`) are display text.
// Given anything but a checked definition it still answers, without
// what it can't read, and never throws.

/** The task kinds of the profile, each a key of its task's object. */
const kinds = [
  "call",
  "do",
  "emit",
  "for",
  "fork",
  "listen",
  "raise",
  "run",
  "set",
  "switch",
  "try",
  "wait",
] as const;

const directives = new Set(["continue", "exit", "end"]);

/** Literal text: source that isn't an expression (`${ … }`). */
const literal = (value: JsonValue | undefined): string | null =>
  typeof value === "string" && !value.trimStart().startsWith("${")
    ? value
    : null;

const objectOf = (value: JsonValue | undefined): JsonObject | undefined =>
  isObject(value) ? value : undefined;

/** A task's `then`, as a transition. */
const nextOf = (value: JsonValue | undefined): DiagramNext => {
  if (typeof value !== "string" || value === "continue") {
    return { kind: "continue" };
  }
  if (value === "exit" || value === "end") {
    return { kind: value };
  }
  return directives.has(value)
    ? { kind: "continue" }
    : { kind: "task", task: value };
};

const kindOf = (task: JsonObject): string | undefined => {
  // A for loop has a `do` list of its own; a try has its `catch`.
  if (Object.hasOwn(task, "for")) {
    return "for";
  }
  return kinds.find((kind) => Object.hasOwn(task, kind));
};

const bindingOf = (task: JsonObject): string | null =>
  literal(objectOf(objectOf(task.metadata)?.grasp)?.binding);

/** A positive amount of one unit, as `<n><letter>` in an ISO 8601 duration. */
const part = (value: JsonValue | undefined, letter: string): string =>
  typeof value === "number" && value > 0 ? `${value}${letter}` : "";

/**
 * A wait's literal duration: its text, or its fixed units (`{ minutes: 5 }`)
 * as the ISO 8601 duration they add up to. An expression shows nothing.
 */
const durationOf = (value: JsonValue | undefined): string | null => {
  const text = literal(value);
  const units = objectOf(value);
  if (text !== null || units === undefined) {
    return text;
  }
  const { days, hours, minutes, seconds = 0, milliseconds = 0 } = units;
  if (typeof seconds !== "number" || typeof milliseconds !== "number") {
    return null;
  }
  // Seconds carry the milliseconds as their fraction (`PT1.5S`).
  const allSeconds = (seconds * 1000 + milliseconds) / 1000;
  const time = `${part(hours, "H")}${part(minutes, "M")}${part(allSeconds, "S")}`;
  const date = part(days, "D");
  if (date === "" && time === "") {
    return "PT0S";
  }
  return `P${date}${time === "" ? "" : `T${time}`}`;
};

/** What a task does, as its literal source says it. */
const detailOf = (kind: string, task: JsonObject): string | null => {
  switch (kind) {
    case "call": {
      const call = literal(task.call);
      const binding = literal(objectOf(task.with)?.binding);
      if (call === null) {
        return null;
      }
      return binding === null ? call : `${call} · ${binding}`;
    }
    case "run": {
      const workflow = objectOf(objectOf(task.run)?.workflow);
      const name = literal(workflow?.name);
      const version = literal(workflow?.version);
      return name === null
        ? null
        : `${name}${version === null ? "" : ` ${version}`}`;
    }
    case "raise": {
      const raised = objectOf(task.raise)?.error;
      // A reusable error (`use.errors`) by its name; an inline one by its
      // title, else its type.
      const error = objectOf(raised);
      return literal(raised) ?? literal(error?.title) ?? literal(error?.type);
    }
    case "wait": {
      return durationOf(task.wait);
    }
    case "emit":
    case "listen": {
      return bindingOf(task);
    }
    default: {
      return null;
    }
  }
};

/** The tasks of the list at `pointer`. */
const tasksOf = (
  value: JsonValue | undefined,
  pointer: string
): DiagramTask[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const tasks: DiagramTask[] = [];
  for (const [index, item] of value.entries()) {
    const entry = objectOf(item);
    const [id] = entry === undefined ? [] : Object.keys(entry);
    if (entry !== undefined && id !== undefined) {
      // eslint-disable-next-line no-use-before-define -- tasks nest in tasks
      const task = taskOf(
        id,
        entry[id],
        pointerJoin(pointerJoin(pointer, index), id)
      );
      if (task !== undefined) {
        tasks.push(task);
      }
    }
  }
  return tasks;
};

const scope = (
  kind: DiagramScope["kind"],
  tasks: DiagramTask[],
  extra: Partial<Omit<DiagramScope, "kind" | "tasks">> = {}
): DiagramScope => ({
  kind,
  name: extra.name ?? null,
  guarded: extra.guarded ?? false,
  next: extra.next ?? null,
  tasks,
});

/** The scopes a task of `kind` holds: its lists, cases and branches. */
const scopesOf = (
  kind: string,
  task: JsonObject,
  pointer: string
): DiagramScope[] => {
  switch (kind) {
    case "do": {
      return [scope("do", tasksOf(task.do, pointerJoin(pointer, "do")))];
    }
    case "for": {
      return [
        scope("each", tasksOf(task.do, pointerJoin(pointer, "do")), {
          name: literal(objectOf(task.for)?.each),
          guarded: Object.hasOwn(task, "while"),
        }),
      ];
    }
    case "switch": {
      const cases = Array.isArray(task.switch) ? task.switch : [];
      return cases.flatMap((item) => {
        const entry = objectOf(item);
        const [name] = entry === undefined ? [] : Object.keys(entry);
        if (entry === undefined || name === undefined) {
          return [];
        }
        const body = objectOf(entry[name]);
        return [
          scope("case", [], {
            name,
            guarded: body !== undefined && Object.hasOwn(body, "when"),
            next: nextOf(body?.then),
          }),
        ];
      });
    }
    case "fork": {
      const branches = objectOf(task.fork)?.branches;
      const branchesPointer = pointerJoin(
        pointerJoin(pointer, "fork"),
        "branches"
      );
      return tasksOf(branches, branchesPointer).map((branch) =>
        scope("branch", [branch], { name: branch.id })
      );
    }
    case "try": {
      const catchBlock = objectOf(task.catch);
      return [
        scope("try", tasksOf(task.try, pointerJoin(pointer, "try"))),
        scope(
          "catch",
          tasksOf(
            catchBlock?.do,
            pointerJoin(pointerJoin(pointer, "catch"), "do")
          ),
          // Where a caught failure goes, when the catch says, which may
          // differ from where the try goes when nothing failed.
          catchBlock !== undefined && Object.hasOwn(catchBlock, "then")
            ? { next: nextOf(catchBlock.then) }
            : {}
        ),
      ];
    }
    default: {
      return [];
    }
  }
};

const taskOf = (
  id: string,
  value: JsonValue | undefined,
  pointer: string
): DiagramTask | undefined => {
  const task = objectOf(value);
  const kind = task === undefined ? undefined : kindOf(task);
  if (task === undefined || kind === undefined) {
    return undefined;
  }
  return {
    id,
    pointer,
    kind,
    label: literal(objectOf(objectOf(task.metadata)?.grasp)?.label),
    detail: detailOf(kind, task),
    guarded: Object.hasOwn(task, "if"),
    next: nextOf(task.then),
    scopes: scopesOf(kind, task, pointer),
  };
};

/** The diagram of `definition`, a checked workflow's parsed JSON. */
export const workflowDiagram = (definition: JsonValue): WorkflowDiagram => ({
  tasks: tasksOf(objectOf(definition)?.do, "/do"),
});
