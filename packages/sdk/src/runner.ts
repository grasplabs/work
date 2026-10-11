import type { ReadRequest, WriteRequest } from "@grasp-os/shared/store-reads";

import { inspectApp } from "./app.ts";
import { databaseReader, databaseWriter } from "./database.ts";
import { isResource } from "./resources.ts";
import type { AnyResource } from "./resources.ts";
import type { AnyFunction, FunctionKind } from "./server.ts";

// How an App's server functions run where its code runs: the runner looks
// a registered function up by path, builds the context of its kind over
// the invocation's channel to the trusted host, and calls its handler.
// Everything the handler does through its context is one call on the
// channel (a read, a staged write, a call of another of the App's
// functions, a resource), and the host decides each: the channel is the
// only authority App code is handed, and a context only shapes calls on
// it. The host validates the arguments before it asks for a run and the
// return after, so the runner validates neither; nor does it trust that
// a context it built limits anything (the host refuses a query's write
// whatever the runner sends).

/**
 * What the host hands the runner for one invocation: methods only, so it
 * can be an RPC stub, and it stops working once the invocation ends.
 */
export interface OperationChannel {
  /** One read of the App's store. */
  readonly read: (request: ReadRequest) => Promise<unknown>;
  /** One staged write: a mutation's only. Answers an insert's minted ID. */
  readonly write: (request: WriteRequest) => Promise<unknown>;
  /**
   * A call of another of the App's functions, by the kind the caller
   * expects (`runQuery`, `runMutation`, `runAction`) and its registered
   * path: the host refuses another kind.
   */
  readonly call: (
    kind: FunctionKind,
    path: string,
    args: unknown
  ) => Promise<unknown>;
  /** One call of a resource the function uses: an action's only. */
  readonly resource: (
    alias: string,
    method: string,
    args: unknown
  ) => Promise<unknown>;
}

/** Why the runner couldn't run what it was asked to. */
const unknownFunction = (): Error =>
  Object.assign(new Error("There is no such operation."), {
    code: "operation.not_found",
  });

/** The path of `reference` among `fn`'s `uses`, or a refusal. */
const usedPath = (
  paths: ReadonlyMap<unknown, string>,
  fn: AnyFunction,
  reference: unknown
): string => {
  const used = fn.uses.find((use) => use === reference);
  const path = used === undefined ? undefined : paths.get(used);
  if (path === undefined) {
    throw Object.assign(
      new Error("A function calls only what it lists in `uses`."),
      { code: "operation.not_found" }
    );
  }
  return path;
};

/** The one method of each kind of resource's client but knowledge's. */
const clientMethods = {
  connector: "call",
  model: "generate",
  template: "read",
} as const;

/** The client of each resource `fn` uses, over `channel`. */
const resourcesOf = (
  fn: AnyFunction,
  channel: OperationChannel
): Readonly<Record<string, unknown>> => {
  const clients: Record<string, unknown> = {};
  const declared: AnyResource[] = fn.uses.filter((use) => isResource(use));
  for (const resource of declared) {
    const call =
      (method: string) =>
      async (...args: unknown[]): Promise<unknown> =>
        await channel.resource(resource.alias, method, args);
    const methods =
      resource["~resource"] === "knowledge"
        ? [...resource.operations]
        : [clientMethods[resource["~resource"]]];
    clients[resource.alias] = Object.freeze(
      Object.fromEntries(methods.map((method) => [method, call(method)]))
    );
  }
  return Object.freeze(clients);
};

/**
 * Runs the function registered at `path` in `registered` (an App `app`
 * made) with `args`, as the host validated them, over `channel`: its
 * handler's answer, or its failure, as thrown.
 */
export const runFunction = async (
  registered: unknown,
  path: string,
  args: unknown,
  channel: OperationChannel
): Promise<unknown> => {
  const inspection = inspectApp(registered);
  const fn =
    typeof path === "string" ? inspection.functions.get(path) : undefined;
  if (fn === undefined) {
    throw unknownFunction();
  }
  const paths = new Map<unknown, string>();
  for (const [registeredPath, registeredFn] of inspection.functions) {
    paths.set(registeredFn, registeredPath);
  }
  // SAFETY: `inspectApp` answers only for an App `app` registered, whose
  // registration carries its schema.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const { schema } = registered as {
    schema: Parameters<typeof databaseReader>[0];
  };
  const read = async (request: ReadRequest) => await channel.read(request);
  const caller =
    (kind: FunctionKind) => async (reference: unknown, callArgs: unknown) =>
      await channel.call(kind, usedPath(paths, fn, reference), callArgs);
  let ctx: object;
  if (fn.kind === "query") {
    ctx = { db: databaseReader(schema, read) };
  } else if (fn.kind === "mutation") {
    ctx = {
      db: databaseWriter(
        schema,
        read,
        async (request: WriteRequest) => await channel.write(request)
      ),
      runQuery: caller("query"),
    };
  } else {
    ctx = {
      runQuery: caller("query"),
      runMutation: caller("mutation"),
      runAction: caller("action"),
      resources: resourcesOf(fn, channel),
    };
  }
  // SAFETY: the context is the one of the function's kind, and the
  // arguments are what the host validated against its `args`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const handler = fn.handler as (ctx: object, args: unknown) => unknown;
  return await handler(Object.freeze(ctx), args);
};
