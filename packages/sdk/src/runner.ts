import type { ReadRequest, WriteRequest } from "@grasp-os/shared/store-reads";

import { AppError } from "./app-error.ts";
import { inspectApp } from "./app.ts";
import { databaseReader, databaseWriter } from "./database.ts";
import { migrationHandler } from "./migration.ts";
import type { MigrationContext } from "./migration.ts";
import { referenceData } from "./references.ts";
import { isResource } from "./resources.ts";
import type { AnyResource } from "./resources.ts";
import type { AnyFunction, FunctionKind } from "./server.ts";
import type { JsonValue } from "./value-descriptor.ts";

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
  /**
   * One progress snapshot of a streaming action (spec 10.7.6), for the
   * screen that runs it: a streaming action's only.
   */
  readonly emit: (progress: unknown) => Promise<unknown>;
}

/** Why the runner couldn't run what it was asked to. */
const unknownFunction = (): Error =>
  Object.assign(new Error("There is no such operation."), {
    code: "operation.not_found",
  });

/**
 * A called function's domain failure as this code's own `AppError` class,
 * which App code catches with `instanceof`: the host sends it as an error
 * named `AppError`, which crossing an isolate leaves a plain `Error`.
 * Anything else as it came.
 */
const asAppError = (error: unknown): unknown => {
  if (
    !(error instanceof Error) ||
    error.name !== "AppError" ||
    error instanceof AppError
  ) {
    return error;
  }
  const code: unknown = Reflect.get(error, "code");
  const details: unknown = Reflect.get(error, "details");
  try {
    // SAFETY: the constructor checks every part, and throws for any it
    // refuses, which leaves the error as it came.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return new AppError(code as string, error.message, details as JsonValue);
  } catch {
    return error;
  }
};

/**
 * The path of `reference` among `fn`'s `uses`, or a refusal: a definition
 * by the path it is registered at, a generated reference by its own,
 * which the App's inspection already matched to what is registered there.
 */
const usedPath = (
  paths: ReadonlyMap<unknown, string>,
  fn: AnyFunction,
  reference: unknown
): string => {
  const used = fn.uses.find((use) => use === reference);
  const path =
    used === undefined
      ? undefined
      : (paths.get(used) ?? referenceData(used)?.path);
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
    (kind: FunctionKind) => async (reference: unknown, callArgs: unknown) => {
      try {
        return await channel.call(
          kind,
          usedPath(paths, fn, reference),
          callArgs
        );
      } catch (error) {
        throw asAppError(error);
      }
    };
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
      // Only a streaming action has `emit`; the host refuses any other's
      // use of the channel's `emit` all the same (`operation.no_stream`).
      ...(fn.stream === null
        ? {}
        : {
            emit: async (progress: unknown): Promise<void> => {
              await channel.emit(progress);
            },
          }),
    };
  }
  // SAFETY: the context is the one of the function's kind, and the
  // arguments are what the host validated against its `args`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const handler = fn.handler as (ctx: object, args: unknown) => unknown;
  return await handler(Object.freeze(ctx), args);
};

/**
 * The manifest of `registered` (an App `app` made), as JSON text: what an
 * App's inspection isolate answers its host, which reads it as hostile
 * (`readAppManifest`). Throws for anything `app` didn't make.
 */
export const manifestOfApp = (registered: unknown): string =>
  JSON.stringify(inspectApp(registered).manifest);

/** One row a migration transforms: its record's ID and fields. */
export interface MigrationRow {
  readonly id: string;
  readonly fields: unknown;
}

/** What the host asks of a migration: its name and a batch of rows. */
export interface MigrationRequest {
  readonly name: string;
  readonly rows: readonly MigrationRow[];
}

/**
 * What a batch answered: each row's output, in order, or the row whose
 * handler threw, and what it said.
 */
export type MigrationAnswer =
  | { readonly ok: true; readonly rows: readonly unknown[] }
  | { readonly ok: false; readonly index: number; readonly message: string };

/** The longest message of a handler's failure a batch answers. */
const failureMaxLength = 500;

/** A function that refuses, for what a migration can't use. */
const unavailable = (what: string) => (): never => {
  throw new Error(
    `A migration is pure: ${what} isn't available while it transforms rows.`
  );
};

/** What a global held before a transform: its own property, if it had one. */
interface Saved {
  readonly target: object;
  readonly key: string;
  readonly own: PropertyDescriptor | undefined;
}

/** Shadows the accessor `key` of `target` with `get` where it can, as `shadow`. */
const shadowGetter = (
  target: object,
  key: string,
  get: () => unknown
): Saved => {
  const own = Object.getOwnPropertyDescriptor(target, key);
  try {
    Object.defineProperty(target, key, { configurable: true, get });
  } catch {
    // Not configurable here: left as it is (see `deterministically`).
  }
  return { target, key, own };
};

/** Shadows `key` of `target` with `value` where it can; what it held before. */
const shadow = (target: object, key: string, value: unknown): Saved => {
  const own = Object.getOwnPropertyDescriptor(target, key);
  try {
    Object.defineProperty(target, key, {
      configurable: true,
      writable: true,
      value,
    });
  } catch {
    // Not configurable here: left as it is (see `deterministically`).
  }
  return { target, key, own };
};

/** Puts back what `saved` held before it was shadowed. */
const restore = ({ target, key, own }: Saved): void => {
  try {
    if (own === undefined) {
      Reflect.deleteProperty(target, key);
    } else {
      Object.defineProperty(target, key, own);
    }
  } catch {
    // As `shadow` left it.
  }
};

/** `Date`, except that it never tells the time. */
const clocklessDate = (): DateConstructor =>
  new Proxy(Date, {
    apply: unavailable("the clock"),
    construct: (target, args: unknown[]) => {
      if (args.length === 0) {
        return unavailable("the clock")();
      }
      // SAFETY: constructing `Date` with arguments makes a `Date`.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      return Reflect.construct(target, args) as Date;
    },
    get: (target, key, receiver): unknown => {
      if (key === "now") {
        return unavailable("the clock");
      }
      const value: unknown = Reflect.get(target, key, receiver);
      return value;
    },
  });

/**
 * The prototypes the shadows reach the real functions through, as they
 * were when the runner loaded, before any App module did: `Date` is also
 * reachable as `Date.prototype.constructor`, and `crypto`'s methods live
 * on its prototype.
 */
const datePrototype = Date.prototype;
const cryptoPrototype: unknown = Object.getPrototypeOf(crypto);
const dateFormatPrototype: object = Intl.DateTimeFormat.prototype;
const formatGetter: unknown = Reflect.getOwnPropertyDescriptor(
  dateFormatPrototype,
  "format"
)?.get;
const formatToParts: unknown = Reflect.getOwnPropertyDescriptor(
  dateFormatPrototype,
  "formatToParts"
)?.value;

/**
 * `Intl.DateTimeFormat`'s `format` getter, as the platform's is: it
 * answers a function bound to its formatter, so a detached
 * `const format = formatter.format` still works. The function refuses to
 * format the current time (no date given); formatting a date it is given
 * is pure.
 */
const datelessFormatGetter = function datelessFormatGetter(
  this: unknown
): unknown {
  const bound: unknown =
    typeof formatGetter === "function"
      ? Reflect.apply(formatGetter, this, [])
      : undefined;
  return (...args: unknown[]): unknown => {
    if (args[0] === undefined || typeof bound !== "function") {
      return unavailable("the clock")();
    }
    const formatted: unknown = Reflect.apply(bound, undefined, args);
    return formatted;
  };
};

/** `Intl.DateTimeFormat`'s `formatToParts`, as `datelessFormat`. */
const datelessFormatToParts = function datelessFormatToParts(
  this: unknown,
  ...args: unknown[]
): unknown {
  if (args[0] === undefined || typeof formatToParts !== "function") {
    return unavailable("the clock")();
  }
  const parts: unknown = Reflect.apply(formatToParts, this, args);
  return parts;
};

/**
 * Runs `work` with randomness and the clocks taken away (`Math.random`,
 * `crypto`'s random values on the object and its prototype, `Date.now`,
 * `new Date()` through `Date` or `Date.prototype.constructor`,
 * `performance.now`, and `Intl.DateTimeFormat` formatting the current
 * time), restoring them after, so a transform answers the same for the
 * same row however often a batch is retried. Best effort, not a boundary:
 * App code that kept a reference to one from before, or a value computed
 * as its modules loaded, still differs between calls, and the isolate has
 * no capability for it to misuse either way. So a retried batch is
 * answered from the store's receipt and never compared with an earlier
 * answer.
 */
const deterministically = <Result>(work: () => Result): Result => {
  const clockless = clocklessDate();
  const prototypeOfCrypto =
    typeof cryptoPrototype === "object" && cryptoPrototype !== null
      ? cryptoPrototype
      : crypto;
  const saved = [
    shadow(Math, "random", unavailable("randomness")),
    shadow(crypto, "getRandomValues", unavailable("randomness")),
    shadow(crypto, "randomUUID", unavailable("randomness")),
    shadow(prototypeOfCrypto, "getRandomValues", unavailable("randomness")),
    shadow(prototypeOfCrypto, "randomUUID", unavailable("randomness")),
    shadow(performance, "now", unavailable("the clock")),
    shadow(globalThis, "Date", clockless),
    shadow(datePrototype, "constructor", clockless),
    shadowGetter(dateFormatPrototype, "format", datelessFormatGetter),
    shadow(dateFormatPrototype, "formatToParts", datelessFormatToParts),
  ];
  try {
    return work();
  } finally {
    for (const one of saved.toReversed()) {
      restore(one);
    }
  }
};

/**
 * `output` as JSON data, serialized here, inside the deterministic window,
 * so a `toJSON` App code put on it runs without randomness or clocks too.
 * `undefined` (what JSON can't hold) answers null, for the host to refuse.
 */
const asJson = (output: unknown): unknown => {
  const text = JSON.stringify(output);
  if (text === undefined) {
    return null;
  }
  const json: unknown = JSON.parse(text);
  return json;
};

/** Whether `value` looks like a promise: anything with a `then` function. */
const isThenable = (value: unknown): boolean =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  typeof Reflect.get(value, "then") === "function";

/**
 * Runs migration `request.name` of `registered` (an App `app` made) on
 * `request.rows`, one at a time, in order, deterministically: each row's
 * output, or the first row whose handler threw or answered a promise. The
 * host validated each row before and validates each output after, so the
 * runner validates neither.
 */
export const runMigration = (
  registered: unknown,
  request: MigrationRequest
): MigrationAnswer => {
  const declared = inspectApp(registered).migrations.get(request.name);
  if (declared === undefined) {
    throw Object.assign(new Error("There is no such migration."), {
      code: "migration.not_found",
    });
  }
  const handler = migrationHandler(declared);
  const { name, table, fromSchema, toSchema } = declared["~migration"];
  return deterministically((): MigrationAnswer => {
    const rows: unknown[] = [];
    for (const [index, row] of request.rows.entries()) {
      const ctx: MigrationContext = Object.freeze({
        migration: name,
        table,
        fromSchema,
        toSchema,
        id: row.id,
      });
      try {
        const output = handler(ctx, row.fields);
        if (isThenable(output)) {
          throw new Error(
            "A migration's handler answers its row, not a promise: it has nothing to wait for."
          );
        }
        rows.push(asJson(output));
      } catch (error) {
        return {
          ok: false,
          index,
          message: (error instanceof Error
            ? error.message
            : "The handler threw"
          ).slice(0, failureMaxLength),
        };
      }
    }
    return { ok: true, rows };
  });
};
