import type { ValueDescriptor } from "@grasp-os/runtime/app";
import { isPathSegment } from "@grasp-os/runtime/host";

import { servedElsewhere } from "./openapi.ts";
import type { Spec, SpecOperation } from "./openapi.ts";
import {
  isNamePart,
  nameMaxLength,
  pathSegments,
  readRoute,
  routeName,
  standardActions,
} from "./tool-names.ts";
import type { DeclaredRoute, HttpMethod } from "./tool-names.ts";

// The mirror rule, checked for every connector's tools whoever wrote them
// (GRA-2319): a tool is one route of the vendor's API, its primary route,
// named from that route (tool-names.ts), with the vendor's own parameter
// and field names, and a list answers `{ items, next }`. Narrowing is
// allowed: a tool may take fewer arguments, fix values, keep fewer fields
// of an answer, and read before it writes.
//
// The primary route is the tool's one write, if it has one (sent last, as
// the API holds it), else the read it declares first. Every other route is
// a GET, of any family, on the connector's hosts: a check before a write
// (whose mailbox, whether a list is shared) or a write's `find`. A path the
// naming rule can't name (`/drive/root:/{name}:/content`) takes the vendor's
// operation name, and only such a path does. Renaming and reshaping are
// refused.
//
// Every tool is held to the naming rule, and each argument named after a
// path parameter of its routes to one segment, as the egress sends it. Where the vendor's spec is known
// (a generated connector, or one narrowed from it), each tool on one of its
// routes is held to the spec's operation field by field: an argument or a
// field the vendor doesn't have is a renamed one.

/** A tool as the check reads it: what its definition declares. */
export interface MirrorTool {
  readonly name: string;
  /** Its one write, or else its first read, is the route it is named from. */
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
    ? ["email", "datetime", "date", "url", "segment"].find(
        (name) =>
          Object.hasOwn(descriptor, name) &&
          Reflect.get(descriptor, name) === true
      )
    : undefined;

/**
 * Whether an argument put into a path parameter is one segment whatever it
 * holds: a string held to `segment`, a number, or fixed values that each
 * are one.
 */
const holdsSegment = (descriptor: ValueDescriptor): boolean => {
  if (descriptor.nullable) {
    return false;
  }
  if (descriptor.kind === "string") {
    return descriptor.segment === true;
  }
  return (
    descriptor.kind === "number" ||
    valuesOf(descriptor)?.every(
      (value) =>
        typeof value === "number" ||
        (typeof value === "string" && isPathSegment(value))
    ) === true
  );
};

/** Each argument a tool's routes put into a path parameter that isn't one segment. */
const pathArgsOf = (
  tool: MirrorTool,
  routes: readonly DeclaredRoute[]
): string[] => {
  const names = new Set(
    routes.flatMap(({ path }) =>
      (pathSegments(path) ?? []).flatMap((segment) =>
        segment.kind === "parameter" ? [segment.name] : []
      )
    )
  );
  return [...names]
    .filter((name) => {
      const arg = Object.hasOwn(tool.args, name) ? tool.args[name] : undefined;
      return arg !== undefined && !holdsSegment(arg);
    })
    .map(
      (name) =>
        `args.${name} fills the path parameter {${name}}: declare it v.string().segment(), a number or fixed values.`
    );
};

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
  route: DeclaredRoute,
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

/** The standard actions a method may take, where the path can't say which. */
const impliedActions: Readonly<Record<HttpMethod, readonly string[]>> = {
  GET: ["get", "list"],
  HEAD: [],
  POST: ["create"],
  PUT: ["update"],
  PATCH: ["update"],
};

/**
 * A tool on a path the naming rule can't read (`/drive/root:/{name}:/content`):
 * named `<family>.<the vendor's operation name>`, the family its leading
 * segments. A standard action there follows the vendor's operation name,
 * and is only the one its method takes.
 */
const againstUnreadable = (
  tool: MirrorTool,
  { method, path }: DeclaredRoute
): string[] => {
  const family: string[] = [];
  for (const part of path.slice(1).split("/")) {
    if (!isNamePart(part)) {
      break;
    }
    family.push(part);
  }
  if (family.length === 0) {
    return [`${path} names no collection.`];
  }
  const prefix = `${family.join(".")}.`;
  const parts = tool.name.startsWith(prefix)
    ? tool.name.slice(prefix.length).split(".")
    : [];
  const action = parts.at(-1) ?? "";
  const vendors =
    tool.name.length <= nameMaxLength &&
    parts.length > 0 &&
    parts.every(isNamePart) &&
    // A standard action follows a vendor's part: alone, it would name the
    // family's own route.
    (!standardActions.has(action) ||
      (parts.length > 1 && impliedActions[method].includes(action)));
  if (!vendors) {
    return [
      `${method} ${path} is named ${prefix}<the vendor's operation name>.`,
    ];
  }
  return action === "list" && pageItem(tool.returns) === undefined
    ? [listShape]
    : [];
};

/** A tool's name against its route, where no spec says more. */
const againstRoute = (tool: MirrorTool, route: DeclaredRoute): string[] => {
  const segments = pathSegments(route.path);
  if (segments === undefined) {
    return againstUnreadable(tool, route);
  }
  const pages = pageItem(tool.returns) !== undefined;
  const naming = routeName({ ...route, segments }, pages);
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
 * Holds a connector's tools to the mirror rule, and to the vendor's spec
 * where the connector declares one.
 */
export const checkMirror = (
  tools: readonly MirrorTool[],
  spec?: Spec
): MirrorProblem[] => {
  const key = (method: string, path: string): string =>
    `${method} ${shapeOf(path)}`;
  const byShape = new Map(
    (spec?.operations ?? []).map((operation) => [
      key(operation.method, operation.path),
      operation,
    ])
  );
  const skipped = new Map(
    (spec?.skipped ?? []).map(({ operation, reason }) => {
      const space = operation.indexOf(" ");
      return [
        key(operation.slice(0, space), operation.slice(space + 1)),
        reason,
      ];
    })
  );
  /** Why a route of a tool held to the spec is none of its operations. */
  const missing = (route: DeclaredRoute): string => {
    const reason = skipped.get(key(route.method, route.path));
    return reason === undefined
      ? `${route.method} ${route.path} isn't an operation of the vendor's spec.`
      : `${route.method} ${route.path} makes no tool: ${reason}`;
  };
  /**
   * Why a route calls a host its spec doesn't. One its connector doesn't
   * list, `defineConnector` already refuses.
   */
  const offHost = ({ method, host, path }: DeclaredRoute): string[] =>
    spec === undefined || host === undefined || host === spec.host
      ? []
      : [`${method} ${host}${path} isn't on the spec's host ${spec.host}.`];
  /** The tool against the route it is named from. */
  const againstPrimary = (tool: MirrorTool, route: DeclaredRoute): string[] => {
    const operation = byShape.get(key(route.method, route.path));
    if (operation !== undefined) {
      return againstOperation(tool, route, operation);
    }
    return spec === undefined ? againstRoute(tool, route) : [missing(route)];
  };
  /** Why a route besides the primary one isn't a read the tool may make. */
  const againstOther = (route: DeclaredRoute): string[] => {
    if (route.method !== "GET") {
      return [
        `${route.method} ${route.path} isn't a GET, as a tool's other routes are.`,
      ];
    }
    // A skipped operation is still the vendor's to read, unless it is on
    // another server, which a route under the spec's base never reaches.
    const shape = key(route.method, route.path);
    const reason = skipped.get(shape);
    const vendors =
      byShape.has(shape) ||
      (reason !== undefined && reason !== servedElsewhere);
    return spec === undefined || vendors
      ? []
      : [
          `${route.method} ${route.path} isn't an operation of the vendor's spec.`,
        ];
  };
  return tools.flatMap((tool) => {
    const declared = tool.routes.map(readRoute);
    const routes = declared.filter((route) => route !== undefined);
    const writes = routes.filter(
      ({ method }) => method !== "GET" && method !== "HEAD"
    );
    const primary = writes[0] ?? routes[0];
    if (primary === undefined) {
      return [
        { tool: tool.name, message: "It declares no route it is named from." },
      ];
    }
    const problems = [
      ...(routes.length < declared.length
        ? ["A route it declares can't be read."]
        : []),
      ...(writes.length > 1
        ? [`It declares ${writes.length} writes, and a tool sends one.`]
        : []),
      ...againstPrimary(tool, primary),
      ...routes
        .filter((route) => route !== primary && !writes.includes(route))
        .flatMap(againstOther),
      ...routes.flatMap(offHost),
      ...pathArgsOf(tool, routes),
    ];
    return problems.map((message) => ({ tool: tool.name, message }));
  });
};
