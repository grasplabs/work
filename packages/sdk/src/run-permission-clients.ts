import { httpContract } from "./connector-contracts.ts";
import { isActionPermission } from "./manifest-permissions.ts";
import type { OperationChannel } from "./operation-channel.ts";
import type { AnyPermission, AppPermission } from "./permission-types.ts";
import { descriptorOf } from "./sealed-descriptors.ts";
import { isPlainObject } from "./value-descriptor.ts";

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

/** The client of `permission`, over `channel`. */
const clientOf = (
  permission: AnyPermission,
  channel: OperationChannel
): Readonly<Record<string, unknown>> => {
  const call =
    (method: string) =>
    async (...args: unknown[]): Promise<unknown> =>
      await channel.resource(permission.alias, method, args);
  const kind = permission["~permission"];
  if (kind === "ai") {
    return Object.freeze({ generate: generateOf(call("generate")) });
  }
  if (kind === "brain" || kind === "guests") {
    return Object.freeze(
      Object.fromEntries(
        permission.operations.map((method) => [method, call(method)])
      )
    );
  }
  if (kind === "connections" && permission.contract === httpContract) {
    return Object.freeze({
      call: call("call"),
      fetch: httpFetchOf(call("call")),
    });
  }
  return Object.freeze({ call: call("call") });
};

/**
 * The App's permissions as an action's context holds them: `ai`,
 * `brain`, `grasp` and `guests` when declared, and the connections by
 * alias.
 */
export const permissionsOf = (
  permissions: readonly AppPermission[],
  channel: OperationChannel
): Record<string, unknown> => {
  const connections: Record<string, unknown> = {};
  const clients: Record<string, unknown> = {};
  for (const declared of permissions) {
    if (!isActionPermission(declared)) {
      continue;
    }
    const kind = declared["~permission"];
    const client = clientOf(declared, channel);
    if (kind === "connections") {
      connections[declared.alias] = client;
    } else {
      clients[kind] = client;
    }
  }
  return {
    ...clients,
    connections: Object.freeze(connections),
  };
};
