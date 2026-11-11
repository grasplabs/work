import { isPlainObject } from "@grasp-os/shared/json";
import { peopleAlias } from "@grasp-os/shared/notifications";
import type { ReadRequest, WriteRequest } from "@grasp-os/shared/store-reads";

import { AppError } from "./app-error.ts";
import { inspectApp } from "./app.ts";
import { databaseReader } from "./database-reader.ts";
import { databaseWriter } from "./database-writer.ts";
import type { FunctionChannel } from "./function-channel.ts";
import { referenceName } from "./function-references.ts";
import { peopleDirectory } from "./people.ts";
import type { AppPermission } from "./permission-types.ts";
import { permissionsOf } from "./run-permission-clients.ts";
import type { FunctionKind } from "./server-function.ts";
import type { JsonValue } from "./value-descriptor.ts";
import { eventReferenceName } from "./workflow-events.ts";
import type { EventName } from "./workflow-events.ts";

// How an App's server functions run where its code runs: the runner looks
// a registered function up by path, builds the context of its kind over
// the invocation's channel to the trusted host, and calls its handler.
// Everything the handler does through its context is one call on the
// channel (a read, a staged write, a call of another of the App's
// functions, a permission), and the host decides each: the channel is the
// only authority App code is handed, and a context only shapes calls on
// it. The host validates the arguments before it asks for a run and the
// return after, so the runner validates neither; nor does it trust that
// a context it built limits anything (the host refuses a query's write
// whatever the runner sends).

/** Why the runner couldn't run what it was asked to. */
const unknownFunction = (): Error =>
  Object.assign(new Error("There is no such function."), {
    code: "function.not_found",
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
 * The path `reference` names, or a refusal: a definition by the path it
 * is registered at, a generated reference (`api.…`, `internal.…`) by its
 * own. Which function it is, and whether the caller's kind may call it,
 * is the host's to decide.
 */
const calledPath = (
  paths: ReadonlyMap<unknown, string>,
  reference: unknown
): string => {
  const path = paths.get(reference) ?? referenceName(reference);
  if (path === undefined) {
    throw Object.assign(
      new Error("A function calls the App's functions by their references."),
      { code: "function.not_found" }
    );
  }
  return path;
};

/** The event the generated reference `event` names, or a refusal. */
const sentEvent = (event: unknown): EventName => {
  const read = eventReferenceName(event);
  if (read === undefined) {
    throw Object.assign(
      new Error(
        "A mutation sends events with its workflows' generated event references."
      ),
      { code: "function.not_found" }
    );
  }
  return read;
};

/** An event a mutation's handler staged, sent once it returns. */
interface StagedEvent {
  readonly event: EventName;
  readonly runId: unknown;
  readonly data: unknown;
}

/**
 * A mutation's `ctx.sendEvent`, over `channel`: each call kept
 * in order while the handler runs, synchronously, and sent to the host by
 * `flush` once it has returned, in that order, which is each one's place
 * among the commit's intents; nothing for a handler that throws, whose
 * mutation commits nothing. The host checks each again as it stages it.
 */
const eventSendsOf = (channel: FunctionChannel) => {
  const staged: StagedEvent[] = [];
  let open = true;
  return {
    sendEvent: (event: unknown, options: unknown): void => {
      if (!open) {
        throw Object.assign(
          new Error("A mutation sends events only while its handler runs."),
          { code: "function.ended" }
        );
      }
      const given = isPlainObject(options) ? options : {};
      staged.push({
        event: sentEvent(event),
        runId: given.runId,
        data: given.data,
      });
    },
    flush: async (): Promise<void> => {
      open = false;
      for (const { event, runId, data } of staged) {
        // In order: each one's place among the commit's intents. The host
        // resolves the event's alias in the release it runs.
        // oxlint-disable-next-line no-await-in-loop -- see above
        await channel.permission(event.workflow, "sendEvent", [
          event.alias,
          runId,
          data,
        ]);
      }
    },
  };
};

/**
 * `ctx.workflows`: each of the App's workflows, by alias, whose `start`
 * is, over `channel`, for an action the start itself and for a mutation
 * its start staged with the commit. The host tells them apart by the
 * function it runs, never by this call.
 */
const workflowsOf = (
  permissions: readonly AppPermission[],
  channel: FunctionChannel
): Readonly<Record<string, unknown>> => {
  const workflows: Record<string, unknown> = {};
  for (const declared of permissions) {
    if (declared["~permission"] === "workflows") {
      workflows[declared.alias] = Object.freeze({
        start: async (args?: unknown): Promise<unknown> =>
          await channel.permission(
            declared.alias,
            "start",
            // No args travel as no argument, which JSON can carry: the
            // host applies the workflow's declared default.
            args === undefined ? [] : [args]
          ),
      });
    }
  }
  return Object.freeze(workflows);
};

/**
 * A send to people (`ctx.notifyPeople`, of an action or a mutation), over
 * `channel`: the host tells them apart by the function
 * it runs, as it does starts.
 */
const notifyPeopleOf =
  (channel: FunctionChannel) =>
  async (to: unknown, notification: unknown): Promise<unknown> =>
    await channel.permission(peopleAlias, "notify", [to, notification]);

/** `read`'s answer, or its failure, as data. */
const settledRead = async (
  read: () => Promise<unknown>
): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> => {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error };
  }
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
  channel: FunctionChannel
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
  const { schema } = inspection;
  const permissions = Object.values(inspection.manifest.permissions);
  const read = async (request: ReadRequest) => await channel.read(request);
  const caller =
    (kind: FunctionKind) => async (reference: unknown, callArgs: unknown) => {
      try {
        return await channel.call(kind, calledPath(paths, reference), callArgs);
      } catch (error) {
        throw asAppError(error);
      }
    };
  // The directory, each read of which the host answers on its own.
  const common = {
    people: peopleDirectory(
      async (name, readArgs) => await channel.people(name, readArgs)
    ),
  };
  let ctx: object;
  let eventSends: ReturnType<typeof eventSendsOf> | undefined;
  if (fn.kind === "query") {
    ctx = { ...common, db: databaseReader(schema, read) };
  } else if (fn.kind === "mutation") {
    eventSends = eventSendsOf(channel);
    ctx = {
      ...common,
      db: databaseWriter(
        schema,
        read,
        async (request: WriteRequest) => await channel.write(request)
      ),
      runQuery: caller("query"),
      // Staged with the commit: the host tells a mutation's starts and
      // sends from an action's by the function it runs.
      workflows: workflowsOf(permissions, channel),
      notifyPeople: async (
        to: unknown,
        notification: unknown
      ): Promise<void> => {
        await notifyPeopleOf(channel)(to, notification);
      },
      sendEvent: eventSends.sendEvent,
    };
  } else {
    ctx = {
      ...common,
      runQuery: caller("query"),
      runMutation: caller("mutation"),
      runAction: caller("action"),
      ...permissionsOf(permissions, channel),
      workflows: workflowsOf(permissions, channel),
      // Only a streaming action has `emit`; the host refuses any other's
      // use of the channel's `emit` all the same (`function.no_stream`).
      ...(fn.stream === null
        ? {}
        : {
            emit: async (progress: unknown): Promise<void> => {
              await channel.emit(progress);
            },
          }),
      notifyPeople: notifyPeopleOf(channel),
    };
  }
  // SAFETY: the context is the one of the function's kind, and the
  // arguments are what the host validated against its `args`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const handler = fn.handler as (ctx: object, args: unknown) => unknown;
  // Who calls, read once as the call starts, for every kind. A host that
  // tells it nothing fails only the function that asks, with why.
  const whoCalls = await settledRead(
    async () => await channel.people("user", {})
  );
  Object.defineProperty(ctx, "auth", {
    enumerable: true,
    value: Object.freeze({
      getUser: async (): Promise<unknown> => {
        if (!whoCalls.ok) {
          throw whoCalls.error;
        }
        return await Promise.resolve(whoCalls.value);
      },
    }),
  });
  const answer = await handler(Object.freeze(ctx), args);
  await eventSends?.flush();
  return answer;
};
