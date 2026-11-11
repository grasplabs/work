import { httpContract } from "@grasp-os/shared/http-contract";

import type { FunctionChannel } from "./function-channel.ts";
import { isActionPermission } from "./manifest-permissions.ts";
import { memberName, membersOf } from "./member-names.ts";
import type { AnyPermission, AppPermission } from "./permission-types.ts";
import { descriptorOf } from "./sealed-descriptors.ts";
import { isPlainObject } from "./value-descriptor.ts";

// The clients an action reaches the App's permissions through
// (`ctx.ai`, `ctx.brain`, `ctx.connections.<alias>`, `ctx.grasp`,
// `ctx.guests`), built from the App's sealed declarations as frozen
// objects with no prototype: each declared action, operation or function
// a member, and nothing else. Never a `Proxy`, so a name is a member only
// if it was declared.
//
// What can go wrong, and what holds:
// - The members are names, never authority. Each member sends its alias,
//   its method and its declared name over the channel
//   (`resource(alias, "call", [action, args])`), and the host decides
//   every call there and then, against the release's sealed manifest:
//   the alias is declared, the action is among its actions, an admin bound
//   the permission and granted what it reaches, and the arguments and the
//   answer fit the contract the binding pinned. App code that builds its
//   own client, rewrites the channel's arguments or calls the channel
//   directly reaches nothing more than these members do.
// - An undeclared name isn't a member: undefined at run time (calling it
//   throws a `TypeError` before anything is sent), and a type error. With
//   no prototype, `constructor` and `hasOwnProperty` are undefined too,
//   unless declared, and `toString` always; TypeScript still lists `Object`'s own
//   members on every object type, a limit of the language, and calling one
//   throws the same way.
// - `__proto__` can't be declared (a name starts with a letter), and a
//   declared name becomes an own property, never the prototype.
// - A name that isn't an identifier (one with `-`) maps to a member as
//   member-names.ts says; two names with the same member are refused when
//   declared, so a member names exactly one action.
// - Frozen: App code can't add, replace or remove a member.
// - The runtime calls some members of a value unasked: `then` when it is
//   awaited, `toJSON` when it is stringified, `toString` and `valueOf`
//   when it becomes text or a number. An action whose member is one of
//   them is refused when declared (`checkedActions`), so no client runs an
//   action nobody called.
// - An HTTP connection has `fetch` alone: its path and request are data,
//   which the host checks against the connection's prefixes and methods,
//   and its method picks `get` or `send`, whichever is declared.

/**
 * `ctx.ai.generate`, over `call`: the request, and the descriptor of its
 * `output` when it asks for one, as data the host checks the answer
 * against.
 */
const generateOf =
  (call: (...args: unknown[]) => Promise<unknown>) =>
  async (request: unknown): Promise<unknown> => {
    const { output, ...rest } = isPlainObject(request) ? request : {};
    return output === undefined
      ? await call(rest)
      : await call(rest, descriptorOf(output));
  };

/** Statuses whose response has no body, as `Response` requires. */
const bodilessStatuses: ReadonlySet<number> = new Set([
  101, 103, 204, 205, 304,
]);

/** Reads `value` as an HTTP connection's answer, or refuses it. */
const httpAnswerOf = (
  value: unknown
): { status: number; headers: Record<string, string>; body: string } => {
  const answer = isPlainObject(value) ? value : {};
  const { status, headers, body } = answer;
  if (
    typeof status !== "number" ||
    !isPlainObject(headers) ||
    typeof body !== "string"
  ) {
    throw new TypeError("The HTTP connection's answer isn't one");
  }
  const read: Record<string, string> = {};
  for (const [name, header] of Object.entries(headers)) {
    if (typeof header === "string") {
      read[name] = header;
    }
  }
  return { status, headers: read, body };
};

/**
 * An HTTP connection's `fetch` over its `call`: a GET or HEAD
 * is the declaration's `get`, any other method its `send`; the answer as
 * a `Response`. The host and connect check everything again.
 */
const httpFetchOf =
  (call: (...args: unknown[]) => Promise<unknown>) =>
  async (path: unknown, init: unknown = {}): Promise<Response> => {
    const given = isPlainObject(init) ? init : {};
    const method =
      typeof given.method === "string" ? given.method.toUpperCase() : "GET";
    const read = method === "GET" || method === "HEAD";
    const input: Record<string, unknown> = { method, path };
    if (given.headers !== undefined) {
      input.headers = given.headers;
    }
    if (!read && given.body !== undefined) {
      input.body = given.body;
    }
    const { status, headers, body } = httpAnswerOf(
      await call(read ? "get" : "send", input)
    );
    return new Response(
      bodilessStatuses.has(status) || method === "HEAD" ? null : body,
      { status, headers }
    );
  };

/**
 * The members of `names`, each a call of `call` with its own name first:
 * a connection's actions (`send-mail` as `sendMail`, member-names.ts).
 */
const callsOf = (
  names: readonly string[],
  call: (...args: unknown[]) => Promise<unknown>
): Readonly<Record<string, unknown>> =>
  membersOf(
    names.map((name) => [
      memberName(name),
      async (...args: unknown[]): Promise<unknown> => await call(name, ...args),
    ])
  );

/**
 * `ctx.grasp`: the platform's functions its declaration lists, by path,
 * each a member of its namespace, the part of the path before its first
 * `.`: `statistics.read` as `statistics.read(args)`.
 */
const graspOf = (
  paths: readonly string[],
  call: (...args: unknown[]) => Promise<unknown>
): Readonly<Record<string, unknown>> => {
  const namespaces = new Map<string, [string, unknown][]>();
  for (const path of paths) {
    const [namespace = ""] = path.split(".", 1);
    const functions = namespaces.get(namespace) ?? [];
    functions.push([
      path.slice(namespace.length + 1),
      async (...args: unknown[]): Promise<unknown> => await call(path, ...args),
    ]);
    namespaces.set(namespace, functions);
  }
  return membersOf(
    [...namespaces].map(([namespace, functions]) => [
      namespace,
      membersOf(functions),
    ])
  );
};

/** The client of `permission`, over `channel`. */
const clientOf = (
  permission: AnyPermission,
  channel: FunctionChannel
): Readonly<Record<string, unknown>> => {
  const call =
    (method: string) =>
    async (...args: unknown[]): Promise<unknown> =>
      await channel.resource(permission.alias, method, args);
  const kind = permission["~permission"];
  if (kind === "ai") {
    return membersOf([["generate", generateOf(call("generate"))]]);
  }
  if (kind === "brain" || kind === "guests") {
    return membersOf(
      permission.operations.map((method) => [method, call(method)])
    );
  }
  if (kind === "grasp") {
    return graspOf(Object.keys(permission.functions), call("call"));
  }
  if (permission.contract === httpContract) {
    return membersOf([["fetch", httpFetchOf(call("call"))]]);
  }
  return callsOf(permission.actions, call("call"));
};

/**
 * The App's permissions as an action's context holds them: `ai`,
 * `brain`, `grasp` and `guests` when declared, and the connections by
 * alias.
 */
export const permissionsOf = (
  permissions: readonly AppPermission[],
  channel: FunctionChannel
): Record<string, unknown> => {
  const connections: [string, unknown][] = [];
  const clients: Record<string, unknown> = {};
  for (const declared of permissions) {
    if (!isActionPermission(declared)) {
      continue;
    }
    const kind = declared["~permission"];
    const client = clientOf(declared, channel);
    if (kind === "connections") {
      connections.push([declared.alias, client]);
    } else {
      clients[kind] = client;
    }
  }
  return { ...clients, connections: membersOf(connections) };
};
