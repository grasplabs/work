import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { callPageFunction } from "../src/app-functions.ts";
import { failureOf } from "../src/page-workflows.ts";
import { createIdp } from "./fake-idp.ts";
import {
  called,
  controlCommand,
  definitionOf,
  jsonWorkflowAppsOf,
  objectSchema,
  outcomeOf,
  passing,
  staged,
  startCommand,
  startedOf,
  workflowQuery,
} from "./json-workflow-apps.ts";
import type { Person, WorkflowReference } from "./json-workflow-apps.ts";

// What page-typed-workflows*.test.ts share: the IdP, the App whose page
// starts the typed workflow, and how they read its runs. Each file has the
// IdP answer for its own tests (`mockIdpWith`).

export const idp = createIdp();

export const { signedIn, boundApp } = jsonWorkflowAppsOf(idp);

/** A run as the `run` query shows it: the fields these tests read. */
export const snapshotSchema = z.looseObject({
  runId: z.string(),
  status: z.string(),
  finishedAt: z.number().nullable(),
  waits: z.array(
    z.looseObject({
      kind: z.string(),
      id: z.string(),
      key: z.string(),
      taskId: z.string(),
      openedAt: z.number(),
      deadline: z.number().nullable(),
      purpose: z.string().optional(),
      canRespond: z.boolean().optional(),
    })
  ),
  control: z.object({
    canPause: z.boolean(),
    canResume: z.boolean(),
    canCancel: z.boolean(),
    pendingControl: z
      .object({ kind: z.string(), stage: z.string() })
      .nullable(),
  }),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.string(), message: z.string() }).optional(),
  compensation: z.unknown().optional(),
});

/** What a page follows of a query: the latest push, numbered. */
interface Shown<Value> {
  /** The latest value pushed: undefined before one, or after a refusal. */
  readonly value: Value | undefined;
  /** How many pushes came, 0 before the first. */
  readonly revision: number;
  readonly error: { readonly code: string } | undefined;
}

/** A push as what is shown: its value, or its refusal. */
export const pushShown = <Value>(
  pushed: unknown,
  revision: number,
  read: (value: unknown) => Value
): Shown<Value> => {
  const refused = z.object({ refused: z.string() }).safeParse(pushed);
  return refused.success
    ? { value: undefined, revision, error: { code: refused.data.refused } }
    : { value: read(pushed), revision, error: undefined };
};

/** The refusal `outcome` (`outcomeOf`) is, thrown as one; else it. */
export const settledOf = (answered: unknown): unknown => {
  if (typeof answered === "string") {
    throw Object.assign(new Error(answered), { code: answered });
  }
  return answered;
};

/**
 * `person`'s page of App `app` and its workflow `reference`, as
 * `useWorkflow` reaches core: starts and controls as calls of the
 * reference's mutations over core's function route, and a run and
 * whether one may start as its `run` and `canStart` queries, followed
 * live over the frame.
 */
export const pageRuns = (
  person: Person,
  app: string,
  lease: string,
  reference: WorkflowReference
) => {
  const call = async (text: string): Promise<unknown> =>
    settledOf(outcomeOf(await called(person, app, lease, text)));
  const runs = new Map<string, Shown<z.infer<typeof snapshotSchema> | null>>();
  let canStart: Shown<boolean> = {
    value: undefined,
    revision: 0,
    error: undefined,
  };
  /** Follows `query`, telling `onPush` each push: what stops it. */
  const follow = (
    query: ReturnType<typeof workflowQuery>,
    onPush: (outcome: unknown, revision: number) => void
  ): (() => void) => {
    const callback = Object.assign(
      (push: unknown): void => {
        const { revision, result } = z
          .object({
            revision: z.number(),
            result: z.union([
              z.object({ ok: z.literal(true), value: z.unknown() }),
              z.object({
                ok: z.literal(false),
                error: z.object({ code: z.string() }),
              }),
            ]),
          })
          .parse(push);
        onPush(
          result.ok ? result.value : { refused: result.error.code },
          revision
        );
      },
      {
        [Symbol.dispose]: (): void => {
          // Let go of: nothing more arrives.
        },
      }
    );
    const subscribed = person.api.pages
      .frame(app, lease)
      .watchQuery(JSON.stringify(query), callback);
    return () => {
      // oxlint-disable-next-line promise/prefer-await-to-then -- not awaited here
      void subscribed.then(async (subscription) => {
        await subscription.release();
      });
    };
  };
  return {
    start: async (input: unknown) =>
      startedOf({
        result: { ok: true, value: await call(startCommand(reference, input)) },
      }),
    control: async (
      runId: string,
      kind: "pause" | "resume" | "cancel",
      _onRecovering?: () => void
    ) => staged(await call(controlCommand(reference, kind, runId))),
    followRun: (runId: string, onChange: () => void): (() => void) =>
      follow(workflowQuery(reference, "run", { runId }), (pushed, revision) => {
        runs.set(
          runId,
          pushShown(pushed, revision, (value) =>
            snapshotSchema.nullable().parse(value)
          )
        );
        onChange();
      }),
    peekRun: (runId: string) =>
      runs.get(runId) ?? { value: undefined, revision: 0, error: undefined },
    followBinding: (onChange: () => void): (() => void) =>
      follow(workflowQuery(reference, "canStart", {}), (pushed, revision) => {
        canStart = pushShown(pushed, revision, (value) =>
          z.boolean().parse(value)
        );
        onChange();
      }),
    peekBinding: () => ({
      value:
        canStart.value === undefined ? undefined : { canRun: canStart.value },
    }),
  };
};

/** A page's call `text` answered by core on `on`, as `called` would: its value. */
export const callOn = async (
  on: Env,
  by: Person,
  app: string,
  text: string
): Promise<unknown> =>
  settledOf(
    outcomeOf(
      await callPageFunction(on, by.acting, app, text, Date.now() + 60_000)
    )
  );
/**
 * A definition whose expression fails on its input, in words that quote
 * what it read: a text this short has no ten-thousandth letter.
 */
export const failingOf = (): string =>
  definitionOf([], {
    status: { $expr: 'args.who.split("")[9999].toUpperCase()' },
  });

/**
 * A definition answering more than the App declares: its status, and a
 * field the App's `returns` doesn't have.
 */
export const widerOf = (): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ who: { kind: "string" } }),
    returns: objectSchema({
      status: { kind: "string" },
      secret: { kind: "string" },
    }),
    result: { status: "hello", secret: "ultramarine" },
    steps: [],
  });

/**
 * Core's database for a page's read, `before` run once, just before the
 * first read of a run is sent: a grant or revocation landing while a
 * snapshot is being read.
 */
export const racingRunRead = (before: () => Promise<void>): Env => {
  let pending: Promise<void> | undefined;
  const raced = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        if (property === "bind") {
          return (...args: unknown[]) => {
            const bound: unknown = Reflect.apply(value, target, args);
            // SAFETY: a prepared statement's bind answers a prepared statement.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
            return raced(bound as D1PreparedStatement);
          };
        }
        return async (...args: unknown[]): Promise<unknown> => {
          pending ??= before();
          await pending;
          const answer: unknown = await Reflect.apply(value, target, args);
          return answer;
        };
      },
    });
  return {
    ...env,
    DB: new Proxy(env.DB, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (property === "prepare" && typeof value === "function") {
          return (query: string) => {
            const statement: unknown = Reflect.apply(value, target, [query]);
            // SAFETY: prepare answers a prepared statement.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
            const prepared = statement as D1PreparedStatement;
            return pending === undefined &&
              query.includes('from "workflow_resource_runs"')
              ? raced(prepared)
              : prepared;
          };
        }
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    }),
  };
};

/** A workflow that sleeps a moment, then an hour, then greets. */
export const twoSleepsOf = (): string =>
  definitionOf([
    { id: "first", type: "wait", for: "1 second" },
    { id: "second", type: "wait", for: "1 hour" },
    passing("greet"),
  ]);

/**
 * A workflow asking `recipient` for decision `contract`, as `approval`, in
 * its step `ask`, then greeting.
 */
export const askingOf = (contract: string, recipient: string): string =>
  definitionOf(
    [
      {
        id: "ask",
        type: "decide",
        decision: "approval",
        recipients: [recipient],
        prompt: "Greet them?",
        input: { who: { $expr: "args.who" } },
      },
      passing("greet"),
    ],
    { permissions: { decisions: { approval: { contract } } } }
  );

/** What a failed run's snapshot says of `error`: its code and words. */
export const failureShown = (error: {
  code: string | null;
  message: string;
}) => {
  const { code, message } = failureOf(error);
  return { code, message };
};

/** The status a push shows, "unavailable" for no run, or its refusal's code. */
export const shownOf = (pushed: unknown): unknown => {
  if (pushed === null) {
    return "unavailable";
  }
  return typeof pushed === "string"
    ? pushed
    : z.object({ status: z.string() }).safeParse(pushed).data?.status;
};

/** The waits a snapshot lists: kind, ID, key, task and `canRespond`. */
export const waitsListed = (snapshot: unknown) =>
  z
    .object({
      waits: z.array(
        z.object({
          kind: z.string(),
          id: z.string(),
          key: z.string(),
          taskId: z.string(),
          canRespond: z.boolean().optional(),
        })
      ),
    })
    .parse(snapshot).waits;

/** How many waits a pushed snapshot lists. */
export const waitsShown = (pushed: unknown): number | undefined =>
  z.object({ waits: z.array(z.unknown()) }).safeParse(pushed).data?.waits
    .length;

/** The code `work` was refused with, or "ok". */
export const refusalOf = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
    return "ok";
  } catch (error) {
    const code: unknown =
      error instanceof Error ? Reflect.get(error, "code") : error;
    return code;
  }
};
