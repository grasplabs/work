import { resolveEvaluate } from "@grasp-os/workflow-expressions/source";

import { bindingKinds, resolveContract } from "./catalog.ts";
import type { BindingKind } from "./catalog.ts";
import type { Checker, Site } from "./checker.ts";
import { compileDataSchema } from "./data-schema.ts";
import { pointerJoin } from "./diagnostics.ts";
import { isObject } from "./json-text.ts";
import type { JsonObject, JsonValue } from "./json-text.ts";
import { dslVersion, profileLimits, profileName } from "./limits.ts";
import {
  checkDataFlow,
  checkErrorDefinition,
  checkRetryPolicy,
  checkTask,
  checkTaskId,
  checkTaskList,
  checkTimeout,
  namePattern,
  semverPattern,
} from "./tasks.ts";
import {
  allowKeys,
  at,
  objectAt,
  requireKey,
  textAt,
  workflowSite,
} from "./values.ts";

/**
 * The document around the tasks: upstream `document`, `input`, `output`,
 * `use`, `do`, `timeout` and `evaluate`, and the Grasp metadata in
 * `document.metadata.grasp` (profile, params, bindings, limits).
 */

const site = workflowSite;

/** A parameter or binding name: what `$params.name` and aliases read. */
const identifierPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
/** A reusable error, retry policy or timeout. */
const reusableNamePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
/** `local:code/<file>.ts#<export>`: the workflow's own module manifest. */
const localContractPattern =
  /^local:code\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.ts#[A-Za-z_$][A-Za-z0-9_$]*$/u;
/** A host catalog key: names and versions, never a URL or credential. */
const catalogContractPattern =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u;
const maxContractLength = 256;
/** The kinds a workflow's own modules provide: actions and computations. */
const localKinds = new Set<BindingKind>(["operation", "compute"]);

const isBindingKind = (value: JsonValue | undefined): value is BindingKind =>
  bindingKinds.some((kind) => kind === value);

/** A map in the definition, with at most `limit` entries. */
const mapAt = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  limit: number,
  what: string
): JsonObject | undefined => {
  const map = objectAt(checker, value, pointer, site, what);
  if (map !== undefined && Object.keys(map).length > limit) {
    checker.report.error(
      "profile.too_many",
      at(site, pointer),
      `Declare at most ${limit} ${what}.`
    );
    return undefined;
  }
  return map;
};

const checkParam = (
  checker: Checker,
  name: string,
  value: JsonValue | undefined,
  pointer: string
): void => {
  if (!identifierPattern.test(name)) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointer),
      "Name a parameter as an identifier: a letter, then letters, digits and underscores.",
      { expected: "identifier" }
    );
    return;
  }
  const param = objectAt(checker, value, pointer, site, "the parameter");
  if (param === undefined) {
    return;
  }
  allowKeys(
    checker,
    param,
    ["schema", "label", "required", "default", "sensitive"],
    pointer,
    site
  );
  if (requireKey(checker, param, "label", pointer, site)) {
    textAt(
      checker,
      param.label,
      pointerJoin(pointer, "label"),
      site,
      profileLimits.maxTitleLength
    );
  }
  if (
    requireKey(checker, param, "sensitive", pointer, site) &&
    typeof param.sensitive !== "boolean"
  ) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointerJoin(pointer, "sensitive")),
      "Set sensitive to true or false.",
      { expected: "boolean" }
    );
  }
  const hasRequired = Object.hasOwn(param, "required");
  const hasDefault = Object.hasOwn(param, "default");
  if (hasRequired && param.required !== true) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointerJoin(pointer, "required")),
      "Set required to true, or leave it out and give a default.",
      { expected: "true" }
    );
  }
  if (hasRequired === hasDefault) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointer),
      "Give a parameter exactly one of required: true or a default.",
      { expected: "required or default" }
    );
  }
  if (!requireKey(checker, param, "schema", pointer, site)) {
    return;
  }
  const { default: defaultValue } = param;
  const compiled = compileDataSchema(
    param.schema,
    pointerJoin(pointer, "schema"),
    hasDefault && defaultValue !== undefined
      ? { value: defaultValue, pointer: pointerJoin(pointer, "default") }
      : undefined
  );
  if (!compiled.ok) {
    for (const problem of compiled.problems) {
      checker.report.error(
        problem.code,
        at(site, problem.pointer),
        problem.remedy,
        {
          ...(problem.expected === undefined
            ? {}
            : { expected: problem.expected }),
          ...(problem.reason === undefined ? {} : { reason: problem.reason }),
        }
      );
    }
    return;
  }
  checker.params.set(name, compiled.schema);
};

const checkBinding = (
  checker: Checker,
  alias: string,
  value: JsonValue | undefined,
  pointer: string
): void => {
  if (!identifierPattern.test(alias)) {
    checker.report.error(
      "profile.invalid_value",
      at(site, pointer),
      "Name a binding as an identifier: a letter, then letters, digits and underscores.",
      { expected: "identifier" }
    );
    return;
  }
  const binding = objectAt(checker, value, pointer, site, "the binding");
  if (binding === undefined) {
    return;
  }
  allowKeys(checker, binding, ["kind", "contract"], pointer, site);
  const kindPointer = pointerJoin(pointer, "kind");
  const contractPointer = pointerJoin(pointer, "contract");
  if (
    !requireKey(checker, binding, "kind", pointer, site) ||
    !requireKey(checker, binding, "contract", pointer, site)
  ) {
    return;
  }
  const { kind, contract } = binding;
  if (!isBindingKind(kind)) {
    checker.report.error(
      "profile.invalid_value",
      at(site, kindPointer),
      "Use a binding kind the profile has.",
      {
        expected: bindingKinds.join(", "),
      }
    );
    return;
  }
  const isLocal = typeof contract === "string" && contract.startsWith("local:");
  const validKey =
    typeof contract === "string" &&
    contract.length <= maxContractLength &&
    (isLocal
      ? localContractPattern.test(contract)
      : catalogContractPattern.test(contract));
  if (!validKey || typeof contract !== "string") {
    checker.report.error(
      "profile.invalid_value",
      at(site, contractPointer),
      "Name an exact contract key from the catalog, or local:code/<file>.ts#<export>: never a URL or credential.",
      { expected: "contract key" }
    );
    return;
  }
  if (isLocal && !localKinds.has(kind)) {
    checker.report.error(
      "binding.contract_mismatch",
      at(site, contractPointer),
      "A local module is an operation (an action) or a compute binding.",
      { expected: "operation or compute" }
    );
    return;
  }
  // Each key resolves in one place only: no fallback, no shadowing.
  const resolution = resolveContract(
    isLocal ? checker.options.modules : checker.options.catalog,
    contract,
    checker.catalogBudget
  );
  if (!resolution.found) {
    checker.report.error(
      "binding.unknown_contract",
      at(site, contractPointer),
      isLocal
        ? "Export the module from the workflow's code, or name an existing one."
        : "Name a contract the host catalog has.",
      { reason: resolution.reason }
    );
  } else if (resolution.contract.kind !== kind) {
    checker.report.error(
      "binding.contract_mismatch",
      at(site, kindPointer),
      `The contract is a ${resolution.contract.kind} contract: declare that kind.`,
      { expected: resolution.contract.kind }
    );
  }
  checker.bindings.set(alias, {
    alias,
    kind,
    contractKey: contract,
    pointer,
    referenced: false,
    ...(resolution.found && resolution.contract.kind === kind
      ? { contract: resolution.contract }
      : {}),
  });
};

const checkLimits = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string
): void => {
  const limits = objectAt(checker, value, pointer, site, "limits");
  if (limits === undefined) {
    return;
  }
  const keys = ["maxSteps", "maxModelCalls", "maxActiveMs"] as const;
  allowKeys(checker, limits, keys, pointer, site);
  for (const key of keys) {
    if (!Object.hasOwn(limits, key)) {
      continue;
    }
    const limit = limits[key];
    const limitPointer = pointerJoin(pointer, key);
    if (
      typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 1
    ) {
      checker.report.error(
        "profile.invalid_value",
        at(site, limitPointer),
        "Give a limit as a whole number above 0.",
        {
          expected: "positive integer",
        }
      );
      continue;
    }
    const ceiling = checker.options.ceilings?.[key];
    if (ceiling !== undefined && limit > ceiling) {
      checker.report.error(
        "profile.limit_above_ceiling",
        at(site, limitPointer),
        "A definition's limits can only lower the host's.",
        { expected: `at most ${ceiling}` }
      );
    }
  }
};

const checkGrasp = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string
): void => {
  const grasp = objectAt(
    checker,
    value,
    pointer,
    site,
    "document.metadata.grasp"
  );
  if (grasp === undefined) {
    return;
  }
  allowKeys(
    checker,
    grasp,
    ["profile", "params", "bindings", "limits"],
    pointer,
    site
  );
  if (grasp.profile !== profileName) {
    checker.report.fatal(
      "profile.unknown_profile",
      at(site, pointerJoin(pointer, "profile")),
      `Declare profile "${profileName}": no other profile is known.`,
      { expected: profileName }
    );
  }
  const paramsPointer = pointerJoin(pointer, "params");
  if (requireKey(checker, grasp, "params", pointer, site)) {
    const params = mapAt(
      checker,
      grasp.params,
      paramsPointer,
      profileLimits.maxParams,
      "parameters"
    );
    for (const [name, param] of Object.entries(params ?? {})) {
      checkParam(checker, name, param, pointerJoin(paramsPointer, name));
    }
  }
  const bindingsPointer = pointerJoin(pointer, "bindings");
  if (requireKey(checker, grasp, "bindings", pointer, site)) {
    const bindings = mapAt(
      checker,
      grasp.bindings,
      bindingsPointer,
      profileLimits.maxBindings,
      "bindings"
    );
    for (const [alias, binding] of Object.entries(bindings ?? {})) {
      checkBinding(
        checker,
        alias,
        binding,
        pointerJoin(bindingsPointer, alias)
      );
    }
  }
  if (Object.hasOwn(grasp, "limits")) {
    checkLimits(checker, grasp.limits, pointerJoin(pointer, "limits"));
  }
};

/** namespace, name and version: the identity a run pins. */
const checkIdentity = (
  checker: Checker,
  document: JsonObject,
  pointer: string
): void => {
  const identity: Record<string, string> = {};
  for (const [key, pattern] of [
    ["namespace", namePattern],
    ["name", namePattern],
    ["version", semverPattern],
  ] as const) {
    if (!requireKey(checker, document, key, pointer, site)) {
      continue;
    }
    const text = document[key];
    if (typeof text !== "string" || !pattern.test(text)) {
      checker.report.error(
        "profile.invalid_value",
        at(site, pointerJoin(pointer, key)),
        key === "version"
          ? "Give an exact semantic version, such as 1.0.0."
          : "Use letters, digits and hyphens, at most 63 characters.",
        { expected: key === "version" ? "semantic version" : "name" }
      );
      continue;
    }
    identity[key] = text;
  }
  const { namespace, name, version } = identity;
  if (namespace !== undefined && name !== undefined && version !== undefined) {
    checker.identity = { namespace, name, version };
  }
};

/** title, summary and tags: presentation, bounded. */
const checkDescription = (
  checker: Checker,
  document: JsonObject,
  pointer: string
): void => {
  if (requireKey(checker, document, "title", pointer, site)) {
    textAt(
      checker,
      document.title,
      "/document/title",
      site,
      profileLimits.maxTitleLength
    );
  }
  if (Object.hasOwn(document, "summary")) {
    textAt(
      checker,
      document.summary,
      "/document/summary",
      site,
      profileLimits.maxSummaryLength
    );
  }
  if (Object.hasOwn(document, "tags")) {
    const tags = mapAt(
      checker,
      document.tags,
      "/document/tags",
      profileLimits.maxTags,
      "tags"
    );
    for (const [key, tag] of Object.entries(tags ?? {})) {
      const tagPointer = pointerJoin("/document/tags", key);
      if (key.length > profileLimits.maxTagLength) {
        checker.report.error(
          "profile.invalid_value",
          at(site, tagPointer),
          "Keep a tag's name to 256 characters."
        );
      }
      textAt(checker, tag, tagPointer, site, profileLimits.maxTagLength);
    }
  }
};

const checkDocumentBlock = (
  checker: Checker,
  value: JsonValue | undefined
): void => {
  const pointer = "/document";
  const document = objectAt(checker, value, pointer, site, "document");
  if (document === undefined) {
    return;
  }
  allowKeys(
    checker,
    document,
    [
      "dsl",
      "namespace",
      "name",
      "version",
      "title",
      "summary",
      "tags",
      "metadata",
    ],
    pointer,
    site
  );
  if (
    requireKey(checker, document, "dsl", pointer, site) &&
    document.dsl !== dslVersion
  ) {
    checker.report.error(
      "profile.unsupported_dsl",
      at(site, "/document/dsl"),
      `Set dsl to "${dslVersion}".`,
      {
        expected: dslVersion,
      }
    );
  }
  checkIdentity(checker, document, pointer);
  checkDescription(checker, document, pointer);
  const metadataPointer = "/document/metadata";
  if (!requireKey(checker, document, "metadata", pointer, site)) {
    checker.report.fatal(
      "profile.unknown_profile",
      at(site, metadataPointer),
      `Declare document.metadata.grasp.profile "${profileName}".`,
      { expected: profileName }
    );
  }
  const metadata = objectAt(
    checker,
    document.metadata,
    metadataPointer,
    site,
    "metadata"
  );
  if (metadata === undefined) {
    return;
  }
  allowKeys(checker, metadata, ["grasp"], metadataPointer, site);
  if (!Object.hasOwn(metadata, "grasp")) {
    checker.report.fatal(
      "profile.unknown_profile",
      at(site, pointerJoin(metadataPointer, "grasp")),
      `Declare document.metadata.grasp.profile "${profileName}".`,
      { expected: profileName }
    );
  }
  checkGrasp(checker, metadata.grasp, pointerJoin(metadataPointer, "grasp"));
};

const unsupportedUse = {
  authentications:
    "Authentication is the host's: connectors hold credentials, never the definition.",
  extensions: "Extensions aren't available: they would run hooks around tasks.",
  secrets:
    "Secrets aren't available to workflows: connectors hold credentials.",
  catalogs:
    "Catalogs aren't loaded: bindings name the host's approved contracts.",
};

/** Registers the names in `use` (so tasks can refer to them) and checks them. */
const checkUse = (
  checker: Checker,
  value: JsonValue | undefined
): JsonObject | undefined => {
  const pointer = "/use";
  const use = objectAt(checker, value, pointer, site, "use");
  if (use === undefined) {
    return undefined;
  }
  allowKeys(
    checker,
    use,
    ["functions", "errors", "retries", "timeouts"],
    pointer,
    site,
    unsupportedUse
  );
  const named = (key: string, limit: number): [string, JsonValue][] => {
    if (!Object.hasOwn(use, key)) {
      return [];
    }
    const map = mapAt(checker, use[key], pointerJoin(pointer, key), limit, key);
    const entries = Object.entries(map ?? {});
    return entries.filter(([name]) => {
      if (key === "functions" || reusableNamePattern.test(name)) {
        return true;
      }
      checker.report.error(
        "profile.invalid_value",
        at(site, pointerJoin(pointerJoin(pointer, key), name)),
        "Name it with a letter, then letters, digits, hyphens and underscores (at most 64)."
      );
      return false;
    });
  };
  for (const [name, error] of named("errors", profileLimits.maxReusable)) {
    checker.reusableErrors.add(name);
    checkErrorDefinition(
      checker,
      error,
      pointerJoin("/use/errors", name),
      site,
      true
    );
  }
  for (const [name, retry] of named("retries", profileLimits.maxReusable)) {
    checker.reusableRetries.add(name);
    checkRetryPolicy(checker, retry, pointerJoin("/use/retries", name), site);
  }
  for (const [name, timeout] of named("timeouts", profileLimits.maxReusable)) {
    checker.reusableTimeouts.add(name);
    checkTimeout(checker, timeout, pointerJoin("/use/timeouts", name), site);
  }
  const functions = named("functions", profileLimits.maxFunctions);
  // Every name first, so a function may call one declared after it.
  for (const [name] of functions) {
    checker.functions.set(name, pointerJoin("/use/functions", name));
  }
  return Object.fromEntries(functions);
};

/** Walks reusable functions: each a task with its name as its ID. */
const checkFunctions = (checker: Checker, functions: JsonObject): void => {
  for (const [name, body] of Object.entries(functions)) {
    const pointer = pointerJoin("/use/functions", name);
    const inner: Site = { ...site, scope: [name], inFunction: name };
    if (!checkTaskId(checker, name, pointer, inner)) {
      continue;
    }
    if (isObject(body) && Object.hasOwn(body, "then")) {
      checker.report.error(
        "flow.not_allowed",
        at(inner, pointerJoin(pointer, "then")),
        "A reusable function returns to its caller: leave then off it."
      );
    }
    const record = checkTask(
      checker,
      name,
      body,
      pointer,
      inner,
      checkTaskList
    );
    if (record !== undefined) {
      checker.tasks.push(record);
      // A function's body is a list of its own: a transition in it (a
      // switch's cases) has no sibling to name.
      checker.lists.push({ pointer, tasks: [record], namedTransitions: true });
    }
  }
};

/** Checks the whole definition, recording what the later checks need. */
export const checkDocument = (checker: Checker, root: JsonValue): void => {
  if (!isObject(root)) {
    checker.report.fatal(
      "profile.invalid_value",
      at(site, ""),
      "Write the definition as a JSON object.",
      {
        expected: "object",
      }
    );
  }
  allowKeys(
    checker,
    root,
    ["document", "input", "output", "use", "do", "timeout", "evaluate"],
    "",
    site,
    {
      schedule:
        "Schedules are separately governed triggers: remove schedule and add a trigger.",
    }
  );
  if (!requireKey(checker, root, "document", "", site)) {
    checker.report.fatal(
      "profile.unknown_profile",
      at(site, "/document"),
      `Declare the "${profileName}" profile.`,
      {
        expected: profileName,
      }
    );
  }
  checkDocumentBlock(checker, root.document);
  if (
    Object.hasOwn(root, "evaluate") &&
    resolveEvaluate(root.evaluate) === undefined
  ) {
    checker.report.error(
      "profile.unsupported_evaluate",
      at(site, "/evaluate"),
      'Set evaluate to { "language": "jq", "mode": "strict" }, or leave it out.',
      { expected: "jq, strict" }
    );
  }
  const functions = Object.hasOwn(root, "use")
    ? checkUse(checker, root.use)
    : undefined;
  if (requireKey(checker, root, "input", "", site)) {
    checker.workflowInput = checkDataFlow(
      checker,
      root.input,
      "/input",
      site,
      "from",
      "workflowInputFrom",
      true
    );
  }
  if (requireKey(checker, root, "output", "", site)) {
    checkDataFlow(
      checker,
      root.output,
      "/output",
      site,
      "as",
      "workflowOutputAs",
      true
    );
  }
  if (Object.hasOwn(root, "timeout")) {
    checkTimeout(checker, root.timeout, "/timeout", site);
  }
  if (requireKey(checker, root, "do", "", site)) {
    checkTaskList(checker, root.do, "/do", site, true);
  }
  if (functions !== undefined) {
    checkFunctions(checker, functions);
  }
};
