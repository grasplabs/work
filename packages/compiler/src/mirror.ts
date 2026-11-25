import type { ValueDescriptor } from "@grasp-os/runtime/app";

import type { Spec, SpecOperation } from "./openapi.ts";
import {
  isNamePart,
  readRoute,
  routeName,
  standardActions,
} from "./tool-names.ts";
import type { Route } from "./tool-names.ts";

// The mirror rule, checked for every connector's tools whoever wrote them
// (GRA-2319): a tool is one route of the vendor's API, named from that
// route (tool-names.ts), with the vendor's own parameter and field names,
// and a list answers `{ items, next }`. Narrowing is allowed: a tool may
// take fewer arguments, fix values, and keep fewer fields of an answer.
// Renaming and reshaping are refused.
//
// Every tool is held to the naming rule. Where the vendor's spec is known
// (a generated connector, or one narrowed from it), each tool on one of its
// routes is held to the spec's operation field by field: an argument or a
// field the vendor doesn't have is a renamed one.

/** A tool as the check reads it: what its definition declares. */
export interface MirrorTool {
  readonly name: string;
  /** The first is the route the tool is: it is named from it. */
  readonly routes: readonly string[];
  readonly args: Readonly<Record<string, ValueDescriptor>>;
  readonly returns: ValueDescriptor;
}

export interface MirrorProblem {
  readonly tool: string;
  readonly message: string;
}

const listShape = "A list answers page(item): { items, next }.";

/** The item of `page(item)`, `{ items, next }` and nothing else, if it is one. */
const pageItem = (answer: ValueDescriptor): ValueDescriptor | undefined => {
  if (answer.kind !== "object" || answer.nullable) {
    return undefined;
  }
  const { items, next, ...rest } = answer.fields;
  const page =
    Object.keys(rest).length === 0 &&
    items?.kind === "array" &&
    !items.nullable &&
    items.presence === "required" &&
    next?.kind === "string" &&
    next.nullable &&
    next.presence === "required";
  return page ? items.item : undefined;
};

/** A path's shape: its parameters' names left out. */
const shapeOf = (path: string): string => path.replaceAll(/\{[^{}]*\}/gu, "{}");

type Side = "args" | "returns";

/** The strings or numbers a scalar holds, all of them for its kind's. */
const valuesOf = (
  descriptor: ValueDescriptor
): readonly unknown[] | undefined => {
  if (descriptor.kind === "enum") {
    return descriptor.values;
  }
  return descriptor.kind === "literal" ? [descriptor.value] : undefined;
};

/** A string's format, if it has one. */
const formatOf = (descriptor: ValueDescriptor): string | undefined =>
  descriptor.kind === "string"
    ? ["email", "datetime", "date", "url"].find(
        (name) =>
          Object.hasOwn(descriptor, name) &&
          Reflect.get(descriptor, name) === true
      )
    : undefined;

/** Whether every value of a scalar `inner` is one of scalar `outer`'s. */
const scalarWithin = (
  inner: ValueDescriptor,
  outer: ValueDescriptor
): boolean => {
  const values = valuesOf(inner);
  if (outer.kind === "string") {
    const format = formatOf(outer);
    return inner.kind === "string"
      ? format === undefined || formatOf(inner) === format
      : format === undefined &&
          values?.every((value) => typeof value === "string") === true;
  }
  if (outer.kind === "number") {
    const integers =
      inner.kind === "number"
        ? inner.integer
        : values?.every((value) => Number.isInteger(value)) === true;
    const numbers =
      inner.kind === "number" ||
      values?.every((value) => typeof value === "number") === true;
    return numbers && (integers || !outer.integer);
  }
  if (outer.kind === "boolean") {
    return (
      inner.kind === "boolean" ||
      values?.every((value) => typeof value === "boolean") === true
    );
  }
  const allowed = valuesOf(outer);
  if (allowed !== undefined) {
    return values?.every((value) => allowed.includes(value)) === true;
  }
  return outer.kind === "null" && inner.kind === "null";
};

/**
 * Why `inner`'s values aren't all `outer`'s, or undefined if they are. In
 * `args` the tool is inner (what it sends must be what the vendor takes);
 * in `returns` the vendor is (what it answers must be what the tool
 * declares). Either way the tool's fields must be the vendor's.
 */
const within = (
  inner: ValueDescriptor,
  outer: ValueDescriptor,
  side: Side,
  at: string
): string | undefined => {
  if (inner.nullable && !outer.nullable) {
    return side === "args"
      ? `${at} may be null, which the vendor's isn't.`
      : `${at} isn't nullable, but the vendor's answer may be null.`;
  }
  const optional =
    inner.presence !== "required" && outer.presence === "required";
  if (side === "returns" && optional) {
    return `${at} is required, but the vendor's answer may leave it out.`;
  }
  const differs = `${at} doesn't keep the vendor's type.`;
  if (outer.kind === "json") {
    return undefined;
  }
  if (outer.kind === "union") {
    const members = inner.kind === "union" ? inner.members : [inner];
    const kept = members.every((member) =>
      outer.members.some(
        (candidate) => within(member, candidate, side, at) === undefined
      )
    );
    return kept ? undefined : differs;
  }
  if (inner.kind === "union") {
    return inner.members
      .map((member) => within(member, outer, side, at))
      .find((problem) => problem !== undefined);
  }
  if (outer.kind === "array") {
    return inner.kind === "array"
      ? within(inner.item, outer.item, side, `${at}[]`)
      : differs;
  }
  if (outer.kind === "record") {
    return inner.kind === "record"
      ? within(inner.value, outer.value, side, `${at}{}`)
      : differs;
  }
  if (outer.kind === "object") {
    return inner.kind === "object"
      ? // oxlint-disable-next-line no-use-before-define -- an object's fields are values
        fieldsWithin(inner.fields, outer.fields, side, at)
      : differs;
  }
  return scalarWithin(inner, outer) ? undefined : differs;
};

/** An object's fields: the tool's must be the vendor's, each within. */
const fieldsWithin = (
  inner: Readonly<Record<string, ValueDescriptor>>,
  outer: Readonly<Record<string, ValueDescriptor>>,
  side: Side,
  at: string
): string | undefined => {
  const tool = side === "args" ? inner : outer;
  const vendor = side === "args" ? outer : inner;
  for (const [name, own] of Object.entries(tool)) {
    const theirs = Object.hasOwn(vendor, name) ? vendor[name] : undefined;
    const field = `${at}.${name}`;
    if (theirs === undefined) {
      return `${field} isn't a field of the vendor's: keep the vendor's names and shapes.`;
    }
    const problem =
      side === "args"
        ? within(own, theirs, side, field)
        : within(theirs, own, side, field);
    if (problem !== undefined) {
      return problem;
    }
  }
  return undefined;
};

/** A tool's answer against the vendor's: a page of its items, or as it is. */
const answerAgainst = (
  tool: MirrorTool,
  operation: SpecOperation
): string | undefined => {
  if (operation.page === undefined) {
    return within(operation.returns, tool.returns, "returns", "returns");
  }
  const item = pageItem(tool.returns);
  return item === undefined
    ? listShape
    : within(operation.page.item, item, "returns", "returns.items[]");
};

/** A tool's name, path, arguments and answer against the vendor's operation. */
const againstOperation = (
  tool: MirrorTool,
  route: Route,
  operation: SpecOperation
): string[] => {
  const vendorArgs =
    operation.args.kind === "object" ? operation.args.fields : {};
  return [
    tool.name === operation.name
      ? undefined
      : `${operation.method} ${operation.path} is named ${operation.name}.`,
    route.path === operation.path
      ? undefined
      : `Its route renames the vendor's path parameters: ${operation.path}.`,
    fieldsWithin(tool.args, vendorArgs, "args", "args"),
    answerAgainst(tool, operation),
  ].filter((problem) => problem !== undefined);
};

/** A tool's name against its route, where no spec says more. */
const againstRoute = (
  tool: MirrorTool,
  route: Route,
  base: string
): string[] => {
  const pages = pageItem(tool.returns) !== undefined;
  const naming = routeName(route, base, pages);
  if ("problem" in naming) {
    return [naming.problem];
  }
  const prefix = `${naming.family}.`;
  const action = tool.name.startsWith(prefix)
    ? tool.name.slice(prefix.length)
    : undefined;
  const problems: string[] = [];
  if (naming.action !== undefined && action !== naming.action) {
    problems.push(
      `${route.method} ${route.path} is named ${prefix}${naming.action}.`
    );
  }
  const vendors =
    action !== undefined && isNamePart(action) && !standardActions.has(action);
  if (naming.action === undefined && !vendors) {
    problems.push(
      `${route.method} ${route.path} is named ${prefix}<the vendor's operation name>.`
    );
  }
  if (tool.name.endsWith(".list") && !pages) {
    problems.push(listShape);
  }
  return problems;
};

/**
 * Holds a connector's tools to the mirror rule. `base` is the path its
 * API's routes start with, and `spec` the vendor's, where it is known: its
 * own base then holds.
 */
export const checkMirror = (
  tools: readonly MirrorTool[],
  base: string,
  spec?: Spec
): MirrorProblem[] => {
  const byShape = new Map(
    (spec?.operations ?? []).map((operation) => [
      `${operation.method} ${shapeOf(operation.path)}`,
      operation,
    ])
  );
  return tools.flatMap((tool) => {
    const route = readRoute(tool.routes[0] ?? "");
    if (route === undefined) {
      return [
        { tool: tool.name, message: "It declares no route it is named from." },
      ];
    }
    const operation = byShape.get(`${route.method} ${shapeOf(route.path)}`);
    const problems =
      operation === undefined
        ? againstRoute(tool, route, spec?.base ?? base)
        : againstOperation(tool, route, operation);
    return problems.map((message) => ({ tool: tool.name, message }));
  });
};
