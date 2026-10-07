/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import type { ValueSchema } from "@grasp-os/sdk";
import type { Stage } from "@grasp-os/workflow-expressions/evaluate";
import { parseSlot } from "@grasp-os/workflow-expressions/source";

/**
 * The task kinds of the profile and the walk over a task list. Each task
 * is checked against its upstream shape narrowed to the profile; what it
 * holds that runs (expressions) is recorded for compilation, and what it
 * names (bindings, functions, errors, transitions) for the checks that
 * need the whole definition.
 */
import { checkCall } from "./calls.ts";
import { member, taskIdOf } from "./checker.ts";
import type {
  Checker,
  ListRecord,
  Site,
  TaskRecord,
  Transition,
} from "./checker.ts";
import { pointerJoin } from "./diagnostics.ts";
import { checkRaise, checkRetryPolicy, checkTimeout } from "./errors.ts";
import { checkEmit, checkListen } from "./events.ts";
import { isObject } from "./json-text.ts";
import type { JsonObject, JsonValue } from "./json-text.ts";
import { profileLimits } from "./limits.ts";
import {
  checkArguments,
  requireBinding,
  schemaAt,
  taskDefinition,
} from "./task-parts.ts";
import type { TaskMetadata } from "./task-parts.ts";
import {
  allowKeys,
  at,
  dataValue,
  durationAt,
  expressionOnly,
  literalText,
  objectAt,
  requireKey,
  textAt,
} from "./values.ts";

const baseKeys = [
  "if",
  "input",
  "output",
  "export",
  "timeout",
  "then",
  "metadata",
];

const kindKeys: Readonly<Record<string, readonly string[]>> = {
  call: ["call", "with"],
  do: ["do"],
  emit: ["emit"],
  for: ["for", "while", "do"],
  fork: ["fork"],
  listen: ["listen"],
  raise: ["raise"],
  run: ["run"],
  set: ["set"],
  switch: ["switch"],
  try: ["try", "catch"],
  wait: ["wait"],
};

const kinds = Object.keys(kindKeys);

const taskIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

const maxTaskIdLength = 64;

/** IDs a `then` can't name: they are flow directives. */
const directives = new Set(["continue", "exit", "end"]);

/** Names a loop or a catch binds: jq identifiers, never a workflow variable. */
const variablePattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;

const reservedVariables = new Set([
  "context",
  "input",
  "output",
  "task",
  "workflow",
  "runtime",
  "params",
  "secrets",
  "authorization",
  "ENV",
  "ARGS",
]);

export const semverPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+(?:[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/u;

export const namePattern = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/u;

/** Upstream `input`, `output` or `export`: a schema and a transformation. */
export const checkDataFlow = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site,
  transform: "from" | "as",
  stage: Stage,
  schemaRequired = false
): ValueSchema<unknown, unknown> | undefined => {
  const object = objectAt(checker, value, pointer, site, "it");
  if (object === undefined) {
    return undefined;
  }
  allowKeys(checker, object, ["schema", transform], pointer, site);
  let schema: ValueSchema<unknown, unknown> | undefined;
  if (Object.hasOwn(object, "schema")) {
    schema = schemaAt(
      checker,
      object.schema,
      pointerJoin(pointer, "schema"),
      site
    );
  } else if (schemaRequired) {
    requireKey(checker, object, "schema", pointer, site);
  }
  const transformation = member(object, transform);
  const transformPointer = pointerJoin(pointer, transform);
  if (typeof transformation === "string") {
    expressionOnly(checker, transformation, transformPointer, stage, site);
  } else if (isObject(transformation)) {
    dataValue(checker, transformation, transformPointer, stage, site);
  } else if (transformation !== undefined) {
    checker.report.error(
      "profile.invalid_value",
      at(site, transformPointer),
      "Write the transformation as ${ … } or an object of values.",
      { expected: "expression or object" }
    );
  }
  return schema;
};

const recordTransition = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site
): Transition | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointer),
      "Write the transition as continue, exit, end or the ID of a later task.",
      { expected: "flow directive" }
    );
    return undefined;
  }
  return { target: value, pointer };
};

const variableAt = (
  checker: Checker,
  value: JsonValue | undefined,
  fallback: string,
  pointer: string,
  site: Site,
  taken: readonly string[],
  owner: { pointer: string; keys: string }
): string => {
  if (value === undefined && taken.includes(fallback)) {
    // The default clashes: point at the loop or catch, where the name goes.
    checker.report.error(
      "profile.invalid_value",
      at(site, owner.pointer),
      `Name this one's variables with ${owner.keys}: the default ${fallback} is already used by an enclosing loop or catch.`
    );
    return fallback;
  }
  const name = value === undefined ? fallback : value;
  const valid =
    typeof name === "string" &&
    variablePattern.test(name) &&
    !reservedVariables.has(name) &&
    !name.startsWith("__") &&
    !taken.includes(name);
  if (!valid) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointer),
      "Name the variable as a plain identifier that no enclosing loop or catch uses and that isn't a workflow variable."
    );
  }
  return typeof name === "string" ? name : fallback;
};

const metadataUses: Readonly<Record<string, readonly string[]>> = {
  binding: ["emit", "listen", "run"],
  key: ["for"],
  concurrency: ["for", "fork"],
};

const checkMetadata = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site,
  kind: string
): TaskMetadata => {
  const metadata: TaskMetadata = {};
  if (value === undefined) {
    return metadata;
  }
  const object = objectAt(checker, value, pointer, site, "metadata");
  if (object === undefined) {
    return metadata;
  }
  allowKeys(checker, object, ["grasp"], pointer, site);
  const graspPointer = pointerJoin(pointer, "grasp");
  if (!Object.hasOwn(object, "grasp")) {
    return metadata;
  }
  const grasp = objectAt(
    checker,
    object.grasp,
    graspPointer,
    site,
    "metadata.grasp"
  );
  if (grasp === undefined) {
    return metadata;
  }
  const applicable = ["label", "position"];
  for (const [key, uses] of Object.entries(metadataUses)) {
    if (uses.includes(kind)) {
      applicable.push(key);
    }
  }
  allowKeys(checker, grasp, applicable, graspPointer, site);
  if (Object.hasOwn(grasp, "label")) {
    textAt(
      checker,
      grasp.label,
      pointerJoin(graspPointer, "label"),
      site,
      profileLimits.maxTitleLength
    );
  }
  if (Object.hasOwn(grasp, "position")) {
    const positionPointer = pointerJoin(graspPointer, "position");
    const position = objectAt(
      checker,
      grasp.position,
      positionPointer,
      site,
      "position"
    );
    if (position !== undefined) {
      allowKeys(checker, position, ["x", "y"], positionPointer, site);
      for (const axis of ["x", "y"]) {
        const coordinate = member(position, axis);
        if (typeof coordinate !== "number") {
          checker.report.error(
            "profile.invalid_value",
            at(site, pointerJoin(positionPointer, axis)),
            "Give x and y as finite numbers.",
            { expected: "number" }
          );
        }
      }
    }
  }
  if (Object.hasOwn(grasp, "binding") && applicable.includes("binding")) {
    metadata.binding = {
      value: grasp.binding,
      pointer: pointerJoin(graspPointer, "binding"),
    };
  }
  if (
    Object.hasOwn(grasp, "concurrency") &&
    applicable.includes("concurrency")
  ) {
    const { concurrency } = grasp;
    if (
      typeof concurrency !== "number" ||
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > profileLimits.maxConcurrency
    ) {
      checker.report.error(
        "profile.invalid_value",
        at(site, pointerJoin(graspPointer, "concurrency")),
        "Set concurrency to a whole number from 1 to 8.",
        { expected: "1-8" }
      );
    }
  }
  return metadata;
};

type WorkflowRef = Partial<Record<"namespace" | "name" | "version", string>>;

/** The literal namespace, name and exact version a run names. */
const workflowRef = (
  checker: Checker,
  workflow: JsonObject,
  pointer: string,
  site: Site
): WorkflowRef => {
  const named: WorkflowRef = {};
  for (const key of ["namespace", "name", "version"] as const) {
    if (!requireKey(checker, workflow, key, pointer, site)) {
      continue;
    }
    const keyPointer = pointerJoin(pointer, key);
    const value = literalText(checker, workflow[key], keyPointer, site, 256);
    const isVersion = key === "version";
    if (
      value !== undefined &&
      !(isVersion ? semverPattern : namePattern).test(value)
    ) {
      checker.report.error(
        "profile.invalid_value",
        at(site, keyPointer),
        isVersion
          ? "Pin an exact semantic version: latest is never selected."
          : "Use the workflow's exact name.",
        { expected: isVersion ? "semantic version" : "name" }
      );
    }
    if (value !== undefined) {
      named[key] = value;
    }
  }
  return named;
};

/** The run names exactly what its binding pins, and not this workflow. */
const checkPinned = (
  checker: Checker,
  named: WorkflowRef,
  pinned: { namespace: string; name: string; version: string },
  pointer: string,
  site: Site
): void => {
  for (const key of ["namespace", "name", "version"] as const) {
    const value = named[key];
    if (value !== undefined && value !== pinned[key]) {
      checker.report.error(
        "binding.contract_mismatch",
        at(site, pointerJoin(pointer, key)),
        "Run exactly the workflow the binding pins.",
        { expected: `${pinned.namespace}/${pinned.name}/${pinned.version}` }
      );
    }
  }
  const { identity } = checker;
  const self =
    identity !== undefined &&
    pinned.namespace === identity.namespace &&
    pinned.name === identity.name &&
    pinned.version === identity.version;
  if (self) {
    checker.report.error(
      "flow.cycle",
      at(site, pointer),
      "A workflow can't run itself as its own child."
    );
  }
};

const runProcesses =
  "Only run.workflow is available: containers, scripts and shells aren't.";

const checkRun = (
  checker: Checker,
  task: JsonObject,
  pointer: string,
  site: Site,
  metadata: TaskMetadata
): void => {
  const binding = requireBinding(checker, metadata, pointer, site, "workflow");
  const runPointer = pointerJoin(pointer, "run");
  const run = objectAt(checker, task.run, runPointer, site, "run");
  if (run === undefined) {
    return;
  }
  allowKeys(checker, run, ["workflow", "await"], runPointer, site, {
    container: runProcesses,
    script: runProcesses,
    shell: runProcesses,
    return: "Leave return out: a child workflow returns its output.",
  });
  if (Object.hasOwn(run, "await") && run.await !== true) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointerJoin(runPointer, "await")),
      "A child workflow is always awaited: no detached children.",
      { expected: "true" }
    );
  }
  if (!requireKey(checker, run, "workflow", runPointer, site)) {
    return;
  }
  const workflowPointer = pointerJoin(runPointer, "workflow");
  const workflow = objectAt(
    checker,
    run.workflow,
    workflowPointer,
    site,
    "the workflow"
  );
  if (workflow === undefined) {
    return;
  }
  allowKeys(
    checker,
    workflow,
    ["namespace", "name", "version", "input"],
    workflowPointer,
    site
  );
  const named = workflowRef(checker, workflow, workflowPointer, site);
  const pinned = binding?.contract?.workflow;
  if (pinned !== undefined) {
    checkPinned(checker, named, pinned, workflowPointer, site);
  }
  if (!Object.hasOwn(workflow, "input")) {
    return;
  }
  const inputPointer = pointerJoin(workflowPointer, "input");
  const input = objectAt(
    checker,
    workflow.input,
    inputPointer,
    site,
    "the child's input"
  );
  if (input !== undefined) {
    const hasExpression = dataValue(
      checker,
      input,
      inputPointer,
      taskDefinition,
      site
    );
    checkArguments(
      checker,
      input,
      hasExpression,
      binding?.contract?.input,
      inputPointer,
      site
    );
  }
};

const checkSet = (
  checker: Checker,
  task: JsonObject,
  pointer: string,
  site: Site
): void => {
  const setPointer = pointerJoin(pointer, "set");
  const { set } = task;
  if (typeof set === "string") {
    expressionOnly(checker, set, setPointer, taskDefinition, site);
    return;
  }
  if (!isObject(set) || Object.keys(set).length === 0) {
    checker.report.error(
      "profile.invalid_value",
      at(site, setPointer),
      "Set an object with at least one member, or ${ … }.",
      { expected: "object or expression" }
    );
    return;
  }
  dataValue(checker, set, setPointer, taskDefinition, site);
};

const checkSwitch = (
  checker: Checker,
  task: JsonObject,
  pointer: string,
  site: Site,
  record: TaskRecord
): void => {
  const switchPointer = pointerJoin(pointer, "switch");
  const cases = task.switch;
  // A skipped switch would fall into its next sibling, usually one of its
  // own branches: the condition belongs in a case.
  if (Object.hasOwn(task, "if")) {
    checker.report.error(
      "flow.not_allowed",
      at(site, pointerJoin(pointer, "if")),
      "Put the condition in a case's when; a switch has no if."
    );
  }
  if (Object.hasOwn(task, "then")) {
    checker.report.error(
      "flow.not_allowed",
      at(site, pointerJoin(pointer, "then")),
      "A switch moves on through its cases' then; leave then off the switch."
    );
  }
  if (
    !Array.isArray(cases) ||
    cases.length === 0 ||
    cases.length > profileLimits.maxSwitchCases
  ) {
    checker.report.error(
      "profile.invalid_value",
      at(site, switchPointer),
      `List 1 to ${profileLimits.maxSwitchCases} cases.`,
      { expected: "nonempty list" }
    );
    return;
  }
  record.cases = [];
  const names = new Set<string>();
  for (const [index, item] of cases.entries()) {
    const itemPointer = pointerJoin(switchPointer, index);
    const entries = isObject(item) ? Object.entries(item) : [];
    const [entry] = entries;
    if (entries.length !== 1 || entry === undefined) {
      checker.report.error(
        "task.not_single_key",
        at(site, itemPointer),
        "Write each case as { name: { when, then } }."
      );
      continue;
    }
    const [name, body] = entry;
    const casePointer = pointerJoin(itemPointer, name);
    if (name.length === 0 || name.length > maxTaskIdLength || names.has(name)) {
      checker.report.error(
        "profile.invalid_value",
        at(site, casePointer),
        "Give each case a distinct name of 1 to 64 characters."
      );
    }
    names.add(name);
    const caseObject = objectAt(checker, body, casePointer, site, "the case");
    if (caseObject === undefined) {
      continue;
    }
    allowKeys(checker, caseObject, ["when", "then"], casePointer, site);
    const hasWhen = Object.hasOwn(caseObject, "when");
    if (hasWhen) {
      expressionOnly(
        checker,
        caseObject.when,
        pointerJoin(casePointer, "when"),
        taskDefinition,
        site,
        "boolean"
      );
    }
    if (!requireKey(checker, caseObject, "then", casePointer, site)) {
      continue;
    }
    const then = recordTransition(
      checker,
      caseObject.then,
      pointerJoin(casePointer, "then"),
      site
    );
    if (then !== undefined) {
      record.cases.push({
        name,
        when: hasWhen,
        next: then,
        pointer: casePointer,
      });
    }
  }
  const defaults = record.cases.filter((switchCase) => !switchCase.when);
  const last = record.cases.at(-1);
  if (defaults.length !== 1 || last === undefined || last.when) {
    checker.report.error(
      "flow.switch_default",
      at(site, switchPointer),
      "End the switch with exactly one case that has no when.",
      { expected: "one last default case" }
    );
  }
};

/** Everything a task's walk needs to recurse into its task lists. */
type ListWalker = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site,
  namedTransitions: boolean
) => void;

const checkFor = (
  checker: Checker,
  task: JsonObject,
  pointer: string,
  site: Site,
  walkList: ListWalker
): void => {
  const forPointer = pointerJoin(pointer, "for");
  const loop = objectAt(checker, task.for, forPointer, site, "for");
  const taken = [...site.loopVariables, ...site.errorVariables];
  let each = "item";
  let index = "index";
  if (loop !== undefined) {
    allowKeys(checker, loop, ["each", "in", "at"], forPointer, site);
    each = variableAt(
      checker,
      member(loop, "each"),
      "item",
      pointerJoin(forPointer, "each"),
      site,
      taken,
      { pointer: forPointer, keys: "for.each and for.at" }
    );
    index = variableAt(
      checker,
      member(loop, "at"),
      "index",
      pointerJoin(forPointer, "at"),
      site,
      [...taken, each],
      { pointer: forPointer, keys: "for.each and for.at" }
    );
    const inPointer = pointerJoin(forPointer, "in");
    if (requireKey(checker, loop, "in", forPointer, site)) {
      const collection = loop.in;
      if (Array.isArray(collection)) {
        if (collection.length > profileLimits.maxInlineItems) {
          checker.report.error(
            "profile.too_many",
            at(site, inPointer),
            `List at most ${profileLimits.maxInlineItems} items inline.`
          );
        }
        dataValue(checker, collection, inPointer, taskDefinition, site);
      } else {
        expressionOnly(
          checker,
          collection,
          inPointer,
          taskDefinition,
          site,
          "array"
        );
      }
    }
  }
  const inner: Site = {
    ...site,
    loopVariables: [...site.loopVariables, each, index],
  };
  if (Object.hasOwn(task, "while")) {
    expressionOnly(
      checker,
      task.while,
      pointerJoin(pointer, "while"),
      taskDefinition,
      inner,
      "boolean"
    );
  }
  const grasp =
    isObject(task.metadata) && isObject(task.metadata.grasp)
      ? task.metadata.grasp
      : undefined;
  if (grasp !== undefined && Object.hasOwn(grasp, "key")) {
    expressionOnly(
      checker,
      grasp.key,
      pointerJoin(
        pointerJoin(pointerJoin(pointer, "metadata"), "grasp"),
        "key"
      ),
      taskDefinition,
      inner
    );
  }
  if (requireKey(checker, task, "do", pointer, site)) {
    walkList(checker, task.do, pointerJoin(pointer, "do"), inner, true);
  }
};

const checkFork = (
  checker: Checker,
  task: JsonObject,
  pointer: string,
  site: Site,
  walkList: ListWalker
): void => {
  const forkPointer = pointerJoin(pointer, "fork");
  const fork = objectAt(checker, task.fork, forkPointer, site, "fork");
  if (fork === undefined) {
    return;
  }
  allowKeys(checker, fork, ["branches", "compete"], forkPointer, site);
  if (Object.hasOwn(fork, "compete") && typeof fork.compete !== "boolean") {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointerJoin(forkPointer, "compete")),
      "Set compete to true or false.",
      { expected: "boolean" }
    );
  }
  if (!requireKey(checker, fork, "branches", forkPointer, site)) {
    return;
  }
  const { branches } = fork;
  if (
    Array.isArray(branches) &&
    branches.length > profileLimits.maxForkBranches
  ) {
    checker.report.error(
      "profile.too_many",
      at(site, pointerJoin(forkPointer, "branches")),
      `Fork at most ${profileLimits.maxForkBranches} branches.`
    );
    return;
  }
  walkList(
    checker,
    branches,
    pointerJoin(forkPointer, "branches"),
    site,
    false
  );
};

const checkTry = (
  checker: Checker,
  task: JsonObject,
  pointer: string,
  site: Site,
  record: TaskRecord,
  walkList: ListWalker
): void => {
  walkList(checker, task.try, pointerJoin(pointer, "try"), site, true);
  const catchPointer = pointerJoin(pointer, "catch");
  if (!requireKey(checker, task, "catch", pointer, site)) {
    return;
  }
  const handler = objectAt(checker, task.catch, catchPointer, site, "catch");
  if (handler === undefined) {
    return;
  }
  allowKeys(
    checker,
    handler,
    ["errors", "as", "when", "exceptWhen", "retry", "do", "then"],
    catchPointer,
    site
  );
  const name = variableAt(
    checker,
    member(handler, "as"),
    "error",
    pointerJoin(catchPointer, "as"),
    site,
    [...site.loopVariables, ...site.errorVariables],
    { pointer: catchPointer, keys: "catch.as" }
  );
  const inner: Site = {
    ...site,
    errorVariables: [...site.errorVariables, name],
  };
  if (Object.hasOwn(handler, "errors")) {
    const errorsPointer = pointerJoin(catchPointer, "errors");
    const errors = objectAt(
      checker,
      handler.errors,
      errorsPointer,
      site,
      "errors"
    );
    if (errors !== undefined) {
      allowKeys(checker, errors, ["with"], errorsPointer, site);
      const filterPointer = pointerJoin(errorsPointer, "with");
      if (requireKey(checker, errors, "with", errorsPointer, site)) {
        const filter = objectAt(
          checker,
          errors.with,
          filterPointer,
          site,
          "the error filter"
        );
        if (filter !== undefined) {
          allowKeys(
            checker,
            filter,
            ["type", "status", "instance", "title", "detail"],
            filterPointer,
            site
          );
          if (Object.keys(filter).length === 0) {
            checker.report.error(
              "profile.invalid_value",
              at(site, filterPointer),
              "Filter on at least one property."
            );
          }
          for (const [key, value] of Object.entries(filter)) {
            const valid =
              key === "status"
                ? typeof value === "number" && Number.isInteger(value)
                : typeof value === "string" &&
                  parseSlot(value).kind === "literal";
            if (!valid) {
              checker.report.error(
                "profile.invalid_value",
                at(site, pointerJoin(filterPointer, key)),
                "Filter on literal values: a whole-number status, text for the rest."
              );
            }
          }
        }
      }
    }
  }
  for (const key of ["when", "exceptWhen"]) {
    if (Object.hasOwn(handler, key)) {
      expressionOnly(
        checker,
        handler[key],
        pointerJoin(catchPointer, key),
        taskDefinition,
        inner,
        "boolean"
      );
    }
  }
  if (Object.hasOwn(handler, "retry")) {
    const retryPointer = pointerJoin(catchPointer, "retry");
    const { retry } = handler;
    if (typeof retry === "string") {
      if (!checker.reusableRetries.has(retry)) {
        checker.report.error(
          "profile.invalid_value",
          at(site, retryPointer),
          "Name a retry policy declared in use.retries.",
          { reason: "unknown retry policy" }
        );
      }
    } else {
      checkRetryPolicy(checker, retry, retryPointer, inner);
    }
  }
  if (Object.hasOwn(handler, "do")) {
    walkList(checker, handler.do, pointerJoin(catchPointer, "do"), inner, true);
  }
  const then = recordTransition(
    checker,
    member(handler, "then"),
    pointerJoin(catchPointer, "then"),
    site
  );
  if (then !== undefined) {
    record.catchNext = then;
  }
};

const kindOf = (task: JsonObject): string[] => {
  const present = kinds.filter((kind) => Object.hasOwn(task, kind));
  // A for loop and a try have a list (`do`, `catch`) of their own.
  return present.includes("for")
    ? present.filter((kind) => kind !== "do")
    : present;
};

/** What every task kind's own check is given. */
interface KindCheck {
  checker: Checker;
  task: JsonObject;
  pointer: string;
  site: Site;
  record: TaskRecord;
  metadata: TaskMetadata;
  walkList: ListWalker;
}

const kindChecks: Readonly<Record<string, (check: KindCheck) => void>> = {
  call: ({ checker, task, pointer, site }) => {
    checkCall(checker, task, pointer, site);
  },
  do: ({ checker, task, pointer, site, walkList }) => {
    walkList(checker, task.do, pointerJoin(pointer, "do"), site, true);
  },
  emit: ({ checker, task, pointer, site, metadata }) => {
    checkEmit(checker, task, pointer, site, metadata);
  },
  for: ({ checker, task, pointer, site, walkList }) => {
    checkFor(checker, task, pointer, site, walkList);
  },
  fork: ({ checker, task, pointer, site, walkList }) => {
    checkFork(checker, task, pointer, site, walkList);
  },
  listen: ({ checker, task, pointer, site, metadata }) => {
    checkListen(checker, task, pointer, site, metadata);
  },
  raise: ({ checker, task, pointer, site }) => {
    checkRaise(checker, task, pointer, site);
  },
  run: ({ checker, task, pointer, site, metadata }) => {
    checkRun(checker, task, pointer, site, metadata);
  },
  set: ({ checker, task, pointer, site }) => {
    checkSet(checker, task, pointer, site);
  },
  switch: ({ checker, task, pointer, site, record }) => {
    checkSwitch(checker, task, pointer, site, record);
  },
  try: ({ checker, task, pointer, site, record, walkList }) => {
    checkTry(checker, task, pointer, site, record, walkList);
  },
  wait: ({ checker, task, pointer, site }) => {
    durationAt(checker, task.wait, pointerJoin(pointer, "wait"), site, {
      stage: taskDefinition,
    });
  },
};

/** The properties every task has: if, input, output, export, timeout, then. */
const checkBase = (
  checker: Checker,
  task: JsonObject,
  pointer: string,
  site: Site,
  record: TaskRecord
): void => {
  if (record.hasIf) {
    expressionOnly(
      checker,
      task.if,
      pointerJoin(pointer, "if"),
      "taskIf",
      site,
      "boolean"
    );
  }
  const flows = [
    ["input", "from", "taskInputFrom"],
    ["output", "as", "taskOutputAs"],
    ["export", "as", "taskExportAs"],
  ] as const;
  for (const [key, transform, stage] of flows) {
    if (Object.hasOwn(task, key)) {
      checkDataFlow(
        checker,
        task[key],
        pointerJoin(pointer, key),
        site,
        transform,
        stage
      );
    }
  }
  if (Object.hasOwn(task, "timeout")) {
    checkTimeout(checker, task.timeout, pointerJoin(pointer, "timeout"), site);
  }
  // A switch moves on through its cases (checkSwitch refuses its then).
  if (record.kind !== "switch") {
    const next = recordTransition(
      checker,
      member(task, "then"),
      pointerJoin(pointer, "then"),
      site
    );
    if (next !== undefined) {
      record.next = next;
    }
  }
};

/**
 * Checks one task: its kind, its own shape and its base properties; walks
 * its task lists through `walkList`. The record it returns is the task as
 * the flow checks see it.
 */
export const checkTask = (
  checker: Checker,
  id: string,
  value: JsonValue | undefined,
  pointer: string,
  site: Site,
  walkList: ListWalker
): TaskRecord | undefined => {
  const task = objectAt(checker, value, pointer, site, "the task");
  if (task === undefined) {
    return undefined;
  }
  const present = kindOf(task);
  const [kind] = present;
  if (kind === undefined || present.length > 1) {
    checker.report.error(
      present.length > 1 ? "task.ambiguous_kind" : "task.unknown_kind",
      at(site, pointer),
      `Give the task exactly one of: ${kinds.join(", ")}.`,
      { expected: "one task kind" }
    );
    return undefined;
  }
  const record: TaskRecord = {
    id,
    kind,
    pointer,
    scope: site.scope,
    hasIf: Object.hasOwn(task, "if"),
  };
  allowKeys(
    checker,
    task,
    [...baseKeys, ...(kindKeys[kind] ?? [])],
    pointer,
    site,
    {
      foreach:
        "Listener foreach isn't available: use a bounded for loop of listens.",
    }
  );
  checkBase(checker, task, pointer, site, record);
  const metadata = checkMetadata(
    checker,
    member(task, "metadata"),
    pointerJoin(pointer, "metadata"),
    site,
    kind
  );
  kindChecks[kind]?.({
    checker,
    task,
    pointer,
    site,
    record,
    metadata,
    walkList,
  });
  return record;
};

/** Whether `id` can be a task's ID; reports why not. */
export const checkTaskId = (
  checker: Checker,
  id: string,
  pointer: string,
  site: Site
): boolean => {
  if (
    id.length > maxTaskIdLength ||
    !taskIdPattern.test(id) ||
    directives.has(id)
  ) {
    checker.report.error(
      "task.invalid_id",
      at(site, pointer),
      "Use 1 to 64 characters of kebab-case starting with a letter, other than continue, exit or end.",
      { expected: "kebab-case" }
    );
    return false;
  }
  if (checker.taskIds.has(id)) {
    checker.report.error(
      "task.duplicate_id",
      at(site, pointer),
      "Give every task, in reusable functions too, its own ID."
    );
    return false;
  }
  checker.taskIds.add(id);
  return true;
};

/**
 * Walks a task list: an ordered, nonempty list of single-key tasks, a scope
 * of its own. Records the list for the flow checks.
 */
export const checkTaskList: ListWalker = (
  checker,
  value,
  pointer,
  site,
  namedTransitions
) => {
  if (!Array.isArray(value)) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointer),
      "Write the tasks as a list.",
      {
        expected: "array",
      }
    );
    return;
  }
  if (value.length === 0) {
    checker.report.error(
      "task.empty_list",
      at(site, pointer),
      "Add at least one task."
    );
    return;
  }
  const list: ListRecord = { pointer, tasks: [], namedTransitions };
  const owner = taskIdOf(site);
  if (owner !== undefined) {
    list.taskId = owner;
  }
  checker.lists.push(list);
  for (const [index, item] of value.entries()) {
    const itemPointer = pointerJoin(pointer, index);
    const entries = isObject(item) ? Object.entries(item) : [];
    const [entry] = entries;
    if (entries.length !== 1 || entry === undefined) {
      checker.report.error(
        "task.not_single_key",
        at(site, itemPointer),
        'Write the task as { "task-id": { … } }.'
      );
      continue;
    }
    const [id, body] = entry;
    const taskPointer = pointerJoin(itemPointer, id);
    if (checker.tasks.length >= profileLimits.maxTasks) {
      // Past this, checking more tasks only costs: the walk stops here.
      checker.report.fatal(
        "task.too_many",
        at(site, taskPointer),
        `Keep the definition to ${profileLimits.maxTasks} tasks, or split it into child workflows.`
      );
    }
    if (site.scope.length + 1 > profileLimits.maxScopes) {
      checker.report.error(
        "task.scope_too_deep",
        at(site, taskPointer),
        "Nest task lists at most 16 deep: move tasks up, or into a child workflow."
      );
      return;
    }
    const inner: Site = { ...site, scope: [...site.scope, id] };
    const valid = checkTaskId(checker, id, taskPointer, inner);
    const record = checkTask(
      checker,
      id,
      body,
      taskPointer,
      inner,
      checkTaskList
    );
    if (record !== undefined) {
      checker.tasks.push(record);
      if (valid) {
        list.tasks.push(record);
      }
    }
  }
};
