import { v } from "@grasp-os/sdk";
import { expectedMessageOf } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction, callPageFunction } from "../src/app-functions.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { appHost } from "../src/durable-objects.ts";
import { failureOf } from "../src/page-workflows.ts";
import { revokePermission } from "../src/permissions.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import {
  repairResourceTerminations,
  terminateResourceRun,
} from "../src/workflows/resource-runs.ts";
import { tellQueryFollowers } from "../src/workflows/run-changes.ts";
import { WorkflowRuns } from "../src/workflows/run-object.ts";
import { grantReviewed } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import {
  called,
  controlCommand,
  definitionOf,
  endLiveResourceRuns,
  following,
  greetingOf,
  jsonWorkflowAppsOf,
  keyOf,
  mutationCall,
  objectSchema,
  passing,
  outcomeOf,
  pageOf,
  queryCall,
  settles,
  staged,
  startCommand,
  startedOf,
  workflowQuery,
} from "./json-workflow-apps.ts";
import type { Person, WorkflowReference } from "./json-workflow-apps.ts";
import { gate, heldEnd, rollingBackRun, withRollbacks } from "./rollbacks.ts";
import { runInstance, sleeping, whileEngineRefuses, woken } from "./runs.ts";
import { person as actingPerson } from "./sealed-apps.ts";
import { auditedDuring, outcome, unique } from "./sign-in.ts";

// A page's typed `useWorkflow` through the real host (spec 10.4,
// page-workflows.ts; the threat model is on GRA-626): its starts and
// controls as calls of the workflow reference's mutations, relayed over
// core's function route, and its run and whether it may start one as the
// reference's `run` and `canStart` queries, followed live through the
// frame's own capability (`pages.frame`), each answer and push checked by
// the descriptors the SDK generates.

const idp = mockIdp();

const { signedIn, boundApp } = jsonWorkflowAppsOf(idp);

/** A run as the `run` query shows it: the fields these tests read. */
const snapshotSchema = z.looseObject({
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
  output: z.unknown().optional(),
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
const pushShown = <Value>(
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
const settledOf = (answered: unknown): unknown => {
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
const pageRuns = (
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
const callOn = async (
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
const failingOf = (): string =>
  definitionOf([], {
    status: { $expr: 'input.who.split("")[9999].toUpperCase()' },
  });

/**
 * A definition answering more than the App declares: its status, and a
 * field the App's output doesn't have.
 */
const widerOf = (): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    input: objectSchema({ who: { kind: "string" } }),
    output: {
      schema: objectSchema({
        status: { kind: "string" },
        secret: { kind: "string" },
      }),
      value: { status: "hello", secret: "ultramarine" },
    },
    steps: [],
  });

/**
 * Core's database for a page's read, `before` run once, just before the
 * first read of a run is sent: a grant or revocation landing while a
 * snapshot is being read.
 */
const racingRunRead = (before: () => Promise<void>): Env => {
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
const twoSleepsOf = (): string =>
  definitionOf([
    { id: "first", type: "wait", for: "1 second" },
    { id: "second", type: "wait", for: "1 hour" },
    passing("greet"),
  ]);

/**
 * A workflow asking `recipient` for decision `contract`, as `approval`, in
 * its step `ask`, then greeting.
 */
const askingOf = (contract: string, recipient: string): string =>
  definitionOf(
    [
      {
        id: "ask",
        type: "decision",
        binding: "approval",
        recipients: [recipient],
        prompt: "Greet them?",
        input: { who: { $expr: "input.who" } },
      },
      passing("greet"),
    ],
    { bindings: { approval: { kind: "decision", contract } } }
  );

/** What a failed run's snapshot says of `error`: its code and words. */
const failureShown = (error: { code: string | null; message: string }) => {
  const { code, message } = failureOf(error);
  return { code, message };
};

/** The status a push shows, "unavailable" for no run, or its refusal's code. */
const shownOf = (pushed: unknown): unknown => {
  if (pushed === null) {
    return "unavailable";
  }
  return typeof pushed === "string"
    ? pushed
    : z.object({ status: z.string() }).safeParse(pushed).data?.status;
};

/** The waits a snapshot lists: kind, ID, key, task and `canRespond`. */
const waitsListed = (snapshot: unknown) =>
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
const waitsShown = (pushed: unknown): number | undefined =>
  z.object({ waits: z.array(z.unknown()) }).safeParse(pushed).data?.waits
    .length;

/** The code `work` was refused with, or "ok". */
const refusalOf = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
    return "ok";
  } catch (error) {
    const code: unknown =
      error instanceof Error ? Reflect.get(error, "code") : error;
    return code;
  }
};

describe(
  "a page's typed workflow through the real host",
  { timeout: 120_000 },
  () => {
    afterEach(endLiveResourceRuns);

    it("starts a run once per key, follows it to its end with its output, and tells the person they may start one", async () => {
      const fixture = await boundApp();
      const { builder, app, reference } = fixture;
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const stopBinding = channel.followBinding(() => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekBinding().value).toStrictEqual({ canRun: true });
      }, settles);

      // The same start sent twice under one key, as a lost answer's resend:
      // one run.
      const start = startCommand(reference, { who: "Ada" });
      const first = outcomeOf(await called(builder, app, lease, start));
      const again = outcomeOf(await called(builder, app, lease, start));
      const handle = z
        .object({
          runId: z.string(),
          workflowId: z.string(),
          workflowVersion: z.number(),
        })
        .parse(first);
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("completed");
      }, settles);
      const shown = channel.peekRun(handle.runId);
      stopRun();
      stopBinding();

      expect({
        again,
        handle: {
          workflowId: handle.workflowId,
          workflowVersion: handle.workflowVersion,
        },
        shown: {
          output: shown.value?.output,
          control: shown.value?.control,
          waits: shown.value?.waits,
        },
      }).toStrictEqual({
        again: first,
        handle: { workflowId: fixture.workflow, workflowVersion: 1 },
        shown: {
          output: { status: "Hello, Ada" },
          control: {
            canPause: false,
            canResume: false,
            canCancel: false,
            pendingControl: null,
          },
          waits: [],
        },
      });
    });

    it("publishes what a run waits on with its status: its task's sleep while it runs, nothing once it has ended", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      // Running, and asleep in its `hold` task: one snapshot says both.
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.waits).toHaveLength(1);
      }, settles);
      const asleep = channel.peekRun(handle.runId);
      await channel.control(handle.runId, "cancel", () => {
        // Answered below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("cancelled");
      }, settles);
      const ended = channel.peekRun(handle.runId);
      stopRun();
      const [wait] = asleep.value?.waits ?? [];

      expect({
        status: asleep.value?.status,
        wait:
          wait === undefined
            ? undefined
            : {
                kind: wait.kind,
                purpose: "purpose" in wait ? wait.purpose : undefined,
                key: wait.key,
                taskId: wait.taskId,
                // An hour's sleep (in seconds), from when it was first reached.
                length:
                  wait.deadline === null
                    ? null
                    : Math.round((wait.deadline - wait.openedAt) / 1000),
              },
        ended: {
          waits: ended.value?.waits,
          later: ended.revision > asleep.revision,
        },
      }).toStrictEqual({
        status: "running",
        wait: {
          kind: "timer",
          purpose: "sleep",
          key: "hold",
          taskId: "hold",
          length: 3600,
        },
        ended: { waits: [], later: true },
      });
    });

    it("lists a decision its run waits on as a wait its starter can't answer, and none once the run ended", async () => {
      const admin = await signedIn("admin");
      const builder = await signedIn("builder");
      const key = `approval-${unique()}`;
      await publishCatalogContract(env, admin.acting, {
        key,
        kind: "decision",
        input: JSON.stringify(v.object({ who: v.string() }).descriptor),
        response: JSON.stringify(v.object({ comment: v.string() }).descriptor),
      });
      const workflow = await createWorkflowResource(
        env,
        builder.acting,
        `ask-${unique()}`
      );
      await publishWorkflowVersion(env, builder.acting, workflow.id, {
        definition: askingOf(key, "role:admin"),
        basedOn: null,
      });
      await approveWorkflowBinding(env, admin.acting, workflow.id, {
        alias: "approval",
        target: { kind: "decision", deciders: ["role:admin"] },
        reviewed: { version: 1 },
      });
      const { app, reference } = await boundApp({
        sharing: { admin, builder, workflow },
      });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      // Asking the admins, its run waits on the decision: one snapshot.
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.waits).toHaveLength(1);
      }, settles);
      const asked = channel.peekRun(handle.runId);
      await channel.control(handle.runId, "cancel", () => {
        // Answered below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("cancelled");
      }, settles);
      const ended = channel.peekRun(handle.runId);
      stopRun();
      const { decision } = z
        .object({ decision: z.string() })
        .parse(
          await env.DB.prepare(
            "SELECT id AS decision FROM workflow_decisions WHERE resource_run_id = ?"
          )
            .bind(handle.runId)
            .first()
        );
      expect({
        asked: waitsListed(asked.value),
        ended: {
          waits: ended.value?.waits,
          later: ended.revision > asked.revision,
        },
      }).toStrictEqual({
        // Metadata only, and never theirs to answer: a run's own person
        // answers none of its decisions (R8).
        asked: [
          {
            kind: "decision",
            id: decision,
            key: "approval",
            taskId: "ask",
            canRespond: false,
          },
        ],
        ended: { waits: [], later: true },
      });
    });

    it("shows a reviewer the real decision wait that asks them, answerable, where its starter sees it unanswerable", async () => {
      const admin = await signedIn("admin");
      const builder = await signedIn("builder");
      const key = `approval-${unique()}`;
      await publishCatalogContract(env, admin.acting, {
        key,
        kind: "decision",
        input: JSON.stringify(v.object({ who: v.string() }).descriptor),
        response: JSON.stringify(v.object({ comment: v.string() }).descriptor),
      });
      const workflow = await createWorkflowResource(
        env,
        builder.acting,
        `ask-${unique()}`
      );
      await publishWorkflowVersion(env, builder.acting, workflow.id, {
        definition: askingOf(key, "role:admin"),
        basedOn: null,
      });
      await approveWorkflowBinding(env, admin.acting, workflow.id, {
        alias: "approval",
        target: { kind: "decision", deciders: ["role:admin"] },
        reviewed: { version: 1 },
      });
      const { app, reference } = await boundApp({
        sharing: { admin, builder, workflow },
      });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      // The engine runs it to its decision, asking the admins.
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.waits).toHaveLength(1);
      }, settles);
      stopRun();
      /** The waits `who` is shown of the run. */
      const waitsShownTo = async (who: Person) => {
        const shown = await callOn(
          env,
          who,
          app,
          queryCall(reference, "run", { runId: handle.runId })
        );
        return waitsListed(shown).map(({ kind, key: asked, canRespond }) => ({
          kind,
          key: asked,
          canRespond,
        }));
      };

      expect({
        starter: await waitsShownTo(builder),
        reviewer: await waitsShownTo(admin),
      }).toStrictEqual({
        // Its own person sees what it waits on, theirs to answer or not.
        starter: [{ kind: "decision", key: "approval", canRespond: false }],
        // The admin it asks watches it for that decision alone, which the
        // reviewer's filter keeps: answerable, so not dropped.
        reviewer: [{ kind: "decision", key: "approval", canRespond: true }],
      });
    });

    it("shows a run's next wait in a push of its own, though it was running all along", async () => {
      const { builder, app, reference } = await boundApp({
        definition: twoSleepsOf,
      });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const shown: { revision: number; keys: string[] }[] = [];
      const stopRun = channel.followRun(handle.runId, () => {
        const now = channel.peekRun(handle.runId);
        if (now.value !== undefined && now.value !== null) {
          shown.push({
            revision: now.revision,
            keys: now.value.waits.map(({ key }) => key),
          });
        }
      });
      await vi.waitFor(() => {
        expect(shown.at(-1)?.keys).toStrictEqual(["second"]);
      }, settles);
      stopRun();
      const first = shown.find(({ keys }) => keys.includes("first"));
      const second = shown.find(({ keys }) => keys.includes("second"));

      expect({
        sawFirst: first !== undefined,
        later:
          first !== undefined &&
          second !== undefined &&
          second.revision > first.revision,
      }).toStrictEqual({ sawFirst: true, later: true });
    });

    it("cancels a run with a receipt answered again under its key", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("running");
      }, settles);
      const running = channel.peekRun(handle.runId).value?.control;
      // The cancel, then sent again under its key, as its resend.
      const cancel = controlCommand(reference, "cancel", handle.runId, keyOf());
      const receipt = outcomeOf(await called(builder, app, lease, cancel));
      const resent = outcomeOf(await called(builder, app, lease, cancel));
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("cancelled");
      }, settles);
      const ended = channel.peekRun(handle.runId);
      stopRun();

      expect({
        running,
        receipt: staged(receipt),
        resent: staged(resent),
        ended: ended.value?.control,
      }).toStrictEqual({
        running: {
          canPause: true,
          canResume: false,
          canCancel: true,
          pendingControl: null,
        },
        receipt: { kind: "cancel", state: "applied" },
        resent: { kind: "cancel", state: "applied" },
        ended: {
          canPause: false,
          canResume: false,
          canCancel: false,
          pendingControl: null,
        },
      });
    });

    it("pauses and resumes a run, each receipt answered again under its key and audited under the App's page for the person", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("running");
      }, settles);
      const commandOf = (command: "pause" | "resume") =>
        controlCommand(reference, command, handle.runId, keyOf());
      const pauseCommand = commandOf("pause");
      let paused = channel.peekRun(handle.runId);
      let pauseAgain: unknown;
      let resumed: unknown;
      let resumedAgain: unknown;
      const events = await auditedDuring(async () => {
        await called(builder, app, lease, pauseCommand);
        await vi.waitFor(() => {
          expect(channel.peekRun(handle.runId).value?.status).toBe("paused");
        }, settles);
        paused = channel.peekRun(handle.runId);
        // Sent again under its key, as a lost answer's resend: the same.
        pauseAgain = outcomeOf(await called(builder, app, lease, pauseCommand));
        resumed = outcomeOf(
          await called(builder, app, lease, commandOf("resume"))
        );
        await vi.waitFor(() => {
          expect(channel.peekRun(handle.runId).value?.status).toBe("running");
        }, settles);
        // A resume of a run already running: applied as it is written.
        resumedAgain = outcomeOf(
          await called(builder, app, lease, commandOf("resume"))
        );
      });
      const running = channel.peekRun(handle.runId);
      stopRun();

      expect({
        paused: paused.value?.control,
        pauseAgain: staged(pauseAgain),
        resumed: staged(resumed),
        resumedAgain: staged(resumedAgain),
        running: running.value?.control,
        later: running.revision > paused.revision,
        audited: events
          .filter(({ target }) => target?.id === handle.runId)
          .map(({ action, actor, detail }) => ({
            action,
            actor: actor.type,
            kind: detail.kind,
            already: detail.already,
            onBehalfOf: detail.onBehalfOf,
          })),
      }).toStrictEqual({
        paused: {
          canPause: false,
          canResume: true,
          canCancel: true,
          pendingControl: null,
        },
        pauseAgain: { kind: "pause", state: "applied" },
        resumed: { kind: "resume", state: "applied" },
        resumedAgain: { kind: "resume", state: "applied" },
        running: {
          canPause: true,
          canResume: false,
          canCancel: true,
          pendingControl: null,
        },
        later: true,
        // Each asked, under the App's page for the person, and each
        // settled, by the system; the resume already done, asked only.
        audited: [
          {
            action: "workflow.run.pause_requested",
            actor: "app",
            kind: undefined,
            already: undefined,
            onBehalfOf: builder.userId,
          },
          {
            action: "workflow.run.control_applied",
            actor: "system",
            kind: "pause",
            already: undefined,
            onBehalfOf: builder.userId,
          },
          {
            action: "workflow.run.resume_requested",
            actor: "app",
            kind: undefined,
            already: undefined,
            onBehalfOf: builder.userId,
          },
          {
            action: "workflow.run.control_applied",
            actor: "system",
            kind: "resume",
            already: undefined,
            onBehalfOf: builder.userId,
          },
          {
            action: "workflow.run.resume_requested",
            actor: "app",
            kind: undefined,
            already: true,
            onBehalfOf: builder.userId,
          },
        ],
      });
    });

    it("keeps a stalled pause applying until a snapshot settles it, refuses a resume meanwhile, and lets a cancel supersede it", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("running");
      }, settles);
      const asked = async (command: "pause" | "resume" | "cancel") =>
        outcomeOf(
          await called(
            builder,
            app,
            lease,
            controlCommand(reference, command, handle.runId, keyOf())
          )
        );
      // A pause admitted a while ago, whose request ended before it asked
      // the engine: stalled, as the repair would find it.
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE workflow_resource_runs SET control_generation = control_generation + 1, summary_revision = summary_revision + 1 WHERE id = ?"
        ).bind(handle.runId),
        env.DB.prepare(
          "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, generation, created_at, next_at) SELECT ?, id, ?, ?, ?, 'pause', 'admitted', control_generation, ?, ? FROM workflow_resource_runs WHERE id = ?"
        ).bind(
          crypto.randomUUID(),
          app,
          builder.userId,
          keyOf(),
          Date.now() - 120_000,
          Date.now() + 3_600_000,
          handle.runId
        ),
      ]);
      await tellQueryFollowers(env, handle.runId);
      await vi.waitFor(() => {
        expect(
          channel.peekRun(handle.runId).value?.control.pendingControl
        ).toStrictEqual({ kind: "pause", stage: "applying" });
      }, settles);
      const applying = channel.peekRun(handle.runId).value;
      let resume: unknown;
      const refusedEvents = await auditedDuring(async () => {
        resume = await refusalOf(
          channel.control(handle.runId, "resume", () => {
            // Never recovering.
          })
        );
      });
      const cancelled = await asked("cancel");
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("cancelled");
      }, settles);
      stopRun();
      const receipts = await env.DB.prepare(
        "SELECT kind, state FROM workflow_resource_run_controls WHERE run_id = ? ORDER BY generation"
      )
        .bind(handle.runId)
        .all<{ kind: string; state: string }>();

      expect({
        applying: { status: applying?.status, control: applying?.control },
        resume,
        refused: refusedEvents
          .filter(({ target }) => target?.id === handle.runId)
          .map(({ action, detail }) => ({
            action,
            kind: detail.kind,
            code: detail.code,
          })),
        cancelled: staged(cancelled),
        receipts: receipts.results,
      }).toStrictEqual({
        applying: {
          status: "running",
          control: {
            canPause: false,
            canResume: false,
            canCancel: true,
            pendingControl: { kind: "pause", stage: "applying" },
          },
        },
        resume: "workflow.control_conflict",
        refused: [
          {
            action: "workflow.run.control_refused",
            kind: "resume",
            code: "workflow.control_conflict",
          },
        ],
        cancelled: { kind: "cancel", state: "applied" },
        receipts: [
          { kind: "pause", state: "superseded" },
          { kind: "cancel", state: "applied" },
        ],
      });
    });

    it("joins a pause still applying when asked again under another key, applying the one receipt", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("running");
      }, settles);
      const asked = async (command: "pause" | "resume" | "cancel") =>
        outcomeOf(
          await called(
            builder,
            app,
            lease,
            controlCommand(reference, command, handle.runId, keyOf())
          )
        );
      // A pause admitted a while ago, whose request ended before it asked
      // the engine: stalled, as the repair would find it.
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE workflow_resource_runs SET control_generation = control_generation + 1, summary_revision = summary_revision + 1 WHERE id = ?"
        ).bind(handle.runId),
        env.DB.prepare(
          "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, generation, created_at, next_at) SELECT ?, id, ?, ?, ?, 'pause', 'admitted', control_generation, ?, ? FROM workflow_resource_runs WHERE id = ?"
        ).bind(
          crypto.randomUUID(),
          app,
          builder.userId,
          keyOf(),
          Date.now() - 120_000,
          Date.now() + 3_600_000,
          handle.runId
        ),
      ]);
      await tellQueryFollowers(env, handle.runId);
      await vi.waitFor(() => {
        expect(
          channel.peekRun(handle.runId).value?.control.pendingControl
        ).toStrictEqual({ kind: "pause", stage: "applying" });
      }, settles);
      const joined = await asked("pause");
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("paused");
      }, settles);
      stopRun();
      const receipts = await env.DB.prepare(
        "SELECT kind, state FROM workflow_resource_run_controls WHERE run_id = ?"
      )
        .bind(handle.runId)
        .all<{ kind: string; state: string }>();

      expect({
        joined: staged(joined),
        receipts: receipts.results,
      }).toStrictEqual({
        joined: { kind: "pause", state: "applied" },
        receipts: [{ kind: "pause", state: "applied" }],
      });
    });

    it("answers a retry of a pause that joined another that pause's receipt, never undoing a resume admitted since", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      const statusIs = async (status: string): Promise<void> => {
        await vi.waitFor(() => {
          expect(channel.peekRun(handle.runId).value?.status).toBe(status);
        }, settles);
      };
      await statusIs("running");
      const asked = async (command: "pause" | "resume", key: string) =>
        outcomeOf(
          await called(
            builder,
            app,
            lease,
            controlCommand(reference, command, handle.runId, key)
          )
        );
      // Pause A, admitted a while ago and not yet sent: stalled.
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE workflow_resource_runs SET control_generation = control_generation + 1, summary_revision = summary_revision + 1 WHERE id = ?"
        ).bind(handle.runId),
        env.DB.prepare(
          "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, generation, created_at, next_at) SELECT ?, id, ?, ?, ?, 'pause', 'admitted', control_generation, ?, ? FROM workflow_resource_runs WHERE id = ?"
        ).bind(
          crypto.randomUUID(),
          app,
          builder.userId,
          keyOf(),
          Date.now() - 120_000,
          Date.now() + 3_600_000,
          handle.runId
        ),
      ]);
      await tellQueryFollowers(env, handle.runId);
      await vi.waitFor(() => {
        expect(
          channel.peekRun(handle.runId).value?.control.pendingControl
        ).toStrictEqual({ kind: "pause", stage: "applying" });
      }, settles);

      // Pause B joins A, which settles; B's answer is lost. Another
      // page resumes the run; then B is sent again under its key.
      const keyB = keyOf();
      const joined = await asked("pause", keyB);
      await statusIs("paused");
      const resumed = await asked("resume", keyOf());
      await statusIs("running");
      const retried = await asked("pause", keyB);
      stopRun();
      const receipts = await env.DB.prepare(
        "SELECT kind, state FROM workflow_resource_run_controls WHERE run_id = ? ORDER BY generation"
      )
        .bind(handle.runId)
        .all<{ kind: string; state: string }>();

      expect({
        joined: staged(joined),
        resumed: staged(resumed),
        retried: staged(retried),
        receipts: receipts.results,
      }).toStrictEqual({
        joined: { kind: "pause", state: "applied" },
        resumed: { kind: "resume", state: "applied" },
        retried: { kind: "pause", state: "applied" },
        receipts: [
          { kind: "pause", state: "applied" },
          { kind: "resume", state: "applied" },
        ],
      });
    });

    it("supersedes a stalled pause a newer control overtook, never sending it", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("running");
      }, settles);
      // A pause admitted, then a newer control's generation taken after it.
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, generation, created_at, next_at) SELECT ?, id, ?, ?, ?, 'pause', 'admitted', control_generation + 1, ?, ? FROM workflow_resource_runs WHERE id = ?"
        ).bind(
          crypto.randomUUID(),
          app,
          builder.userId,
          keyOf(),
          Date.now() - 120_000,
          Date.now() - 60_000,
          handle.runId
        ),
        env.DB.prepare(
          "UPDATE workflow_resource_runs SET control_generation = control_generation + 2, summary_revision = summary_revision + 1 WHERE id = ?"
        ).bind(handle.runId),
      ]);
      await repairResourceTerminations(env, new Date());
      await vi.waitFor(async () => {
        await expect(
          env.DB.prepare(
            "SELECT state FROM workflow_resource_run_controls WHERE run_id = ?"
          )
            .bind(handle.runId)
            .first<string>("state")
        ).resolves.toBe("superseded");
      }, settles);
      // Asked of the run's engine again: still running, never paused.
      await tellQueryFollowers(env, handle.runId);
      await vi.waitFor(() => {
        expect(
          channel.peekRun(handle.runId).value?.control.pendingControl
        ).toBeNull();
      }, settles);
      const shown = channel.peekRun(handle.runId).value?.status;
      stopRun();
      expect(shown).toBe("running");
    });

    it("lets a cancel that lost its write to a pause admitted at once win all the same", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("running");
      }, settles);
      // Just before the cancel's write, a pause's: its receipt stalled, and
      // the run's generation taken.
      let raced = false;
      const racing: Env = {
        ...env,
        DB: new Proxy(env.DB, {
          get: (target, property) => {
            const value: unknown = Reflect.get(target, property);
            if (property === "batch" && typeof value === "function") {
              return async (statements: D1PreparedStatement[]) => {
                if (!raced) {
                  raced = true;
                  await target.batch([
                    target
                      .prepare(
                        "UPDATE workflow_resource_runs SET control_generation = control_generation + 1, summary_revision = summary_revision + 1 WHERE id = ?"
                      )
                      .bind(handle.runId),
                    target
                      .prepare(
                        "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, generation, created_at, next_at) SELECT ?, id, ?, ?, ?, 'pause', 'admitted', control_generation, ?, ? FROM workflow_resource_runs WHERE id = ?"
                      )
                      .bind(
                        crypto.randomUUID(),
                        app,
                        builder.userId,
                        keyOf(),
                        Date.now(),
                        Date.now() + 3_600_000,
                        handle.runId
                      ),
                  ]);
                }
                const answer: unknown = await Reflect.apply(value, target, [
                  statements,
                ]);
                return answer;
              };
            }
            return typeof value === "function"
              ? (...args: unknown[]): unknown =>
                  Reflect.apply(value, target, args)
              : value;
          },
        }),
      };
      const value = await callOn(
        racing,
        builder,
        app,
        controlCommand(reference, "cancel", handle.runId)
      );
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("cancelled");
      }, settles);
      stopRun();
      const receipts = await env.DB.prepare(
        "SELECT kind, state FROM workflow_resource_run_controls WHERE run_id = ? ORDER BY generation"
      )
        .bind(handle.runId)
        .all<{ kind: string; state: string }>();

      expect({
        raced,
        cancel: staged(value),
        receipts: receipts.results,
      }).toStrictEqual({
        raced: true,
        cancel: { kind: "cancel", state: "applied" },
        receipts: [
          { kind: "pause", state: "superseded" },
          { kind: "cancel", state: "applied" },
        ],
      });
    });

    it("never applies a resume at once over a pause that reached the engine while the resume was being decided", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("running");
      }, settles);
      // A pause admitted, not yet sent: due at the repair.
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE workflow_resource_runs SET control_generation = control_generation + 1, summary_revision = summary_revision + 1 WHERE id = ?"
        ).bind(handle.runId),
        env.DB.prepare(
          "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, generation, created_at, next_at) SELECT ?, id, ?, ?, ?, 'pause', 'admitted', control_generation, ?, ? FROM workflow_resource_runs WHERE id = ?"
        ).bind(
          crypto.randomUUID(),
          app,
          builder.userId,
          keyOf(),
          Date.now() - 120_000,
          Date.now() - 60_000,
          handle.runId
        ),
      ]);
      // The resume reads the engine's status; right after, the pause
      // reaches the engine and settles.
      let raced = false;
      const racingStub = <T extends object>(stub: T): T =>
        new Proxy(stub, {
          get: (target, property) => {
            const value: unknown = Reflect.get(target, property);
            if (property === "status" && typeof value === "function") {
              return async (...args: unknown[]) => {
                const status: unknown = await Reflect.apply(
                  value,
                  target,
                  args
                );
                if (!raced) {
                  raced = true;
                  await repairResourceTerminations(env, new Date());
                }
                return status;
              };
            }
            return typeof value === "function"
              ? (...args: unknown[]): unknown =>
                  Reflect.apply(value, target, args)
              : value;
          },
        });
      type Runs = Env["WORKFLOW_RUNS"];
      const racingRuns = (namespace: Runs): Runs =>
        new Proxy(namespace, {
          get: (target, property) => {
            if (property === "jurisdiction") {
              return (jurisdiction: DurableObjectJurisdiction) =>
                racingRuns(target.jurisdiction(jurisdiction));
            }
            if (property === "get") {
              return (id: DurableObjectId) => racingStub(target.get(id));
            }
            const value: unknown = Reflect.get(target, property);
            return typeof value === "function"
              ? (...args: unknown[]): unknown =>
                  Reflect.apply(value, target, args)
              : value;
          },
        });
      const racing: Env = {
        ...env,
        WORKFLOW_RUNS: racingRuns(env.WORKFLOW_RUNS),
      };
      const resume = await refusalOf(
        callOn(
          racing,
          builder,
          app,
          controlCommand(reference, "resume", handle.runId)
        )
      );
      await tellQueryFollowers(env, handle.runId);
      await vi.waitFor(() => {
        const shown = channel.peekRun(handle.runId).value;
        expect(shown?.status).toBe("paused");
        expect(shown?.control.pendingControl).toBeNull();
      }, settles);
      stopRun();
      const receipts = await env.DB.prepare(
        "SELECT kind, state FROM workflow_resource_run_controls WHERE run_id = ? ORDER BY generation"
      )
        .bind(handle.runId)
        .all<{ kind: string; state: string }>();

      // Refused while the pause was still unresolved as it was decided,
      // to be asked again; never answered as done with the run paused.
      expect({ raced, resume, receipts: receipts.results }).toStrictEqual({
        raced: true,
        resume: "workflow.control_conflict",
        receipts: [{ kind: "pause", state: "applied" }],
      });
    });

    it("writes one receipt and one audit event for two overlapping requests under one key of a pause the run is already past", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("running");
      }, settles);
      const pauseOf = (key: string) =>
        controlCommand(reference, "pause", handle.runId, key);
      await callOn(env, builder, app, pauseOf(keyOf()));
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("paused");
      }, settles);
      // The same pause, sent twice: the second runs whole just before the
      // first writes, both having found the run paused and no receipt.
      const retriedKey = keyOf();
      const retried = pauseOf(retriedKey);
      let twin: unknown;
      const racing: Env = {
        ...env,
        DB: new Proxy(env.DB, {
          get: (target, property) => {
            const value: unknown = Reflect.get(target, property);
            if (property === "batch" && typeof value === "function") {
              return async (statements: D1PreparedStatement[]) => {
                if (twin === undefined) {
                  twin = await callOn(env, builder, app, retried);
                }
                const answer: unknown = await Reflect.apply(value, target, [
                  statements,
                ]);
                return answer;
              };
            }
            return typeof value === "function"
              ? (...args: unknown[]): unknown =>
                  Reflect.apply(value, target, args)
              : value;
          },
        }),
      };
      let first: unknown;
      const events = await auditedDuring(async () => {
        first = await callOn(racing, builder, app, retried);
      });
      stopRun();
      const receipts = await env.DB.prepare(
        "SELECT kind, state FROM workflow_resource_run_controls WHERE run_id = ? AND key = ?"
      )
        .bind(handle.runId, retriedKey)
        .all<{ kind: string; state: string }>();

      expect({
        first: staged(first),
        twin: staged(twin),
        receipts: receipts.results,
        audited: events
          .filter(({ target }) => target?.id === handle.runId)
          .map(({ action, detail }) => ({ action, already: detail.already })),
      }).toStrictEqual({
        first: { kind: "pause", state: "applied" },
        twin: { kind: "pause", state: "applied" },
        receipts: [{ kind: "pause", state: "applied" }],
        audited: [{ action: "workflow.run.pause_requested", already: true }],
      });
    });

    it("applies a stalled pause at the next repair, the run's snapshot moving on from applying to paused", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("running");
      }, settles);
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE workflow_resource_runs SET control_generation = control_generation + 1, summary_revision = summary_revision + 1 WHERE id = ?"
        ).bind(handle.runId),
        env.DB.prepare(
          "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, generation, created_at, next_at) SELECT ?, id, ?, ?, ?, 'pause', 'admitted', control_generation, ?, ? FROM workflow_resource_runs WHERE id = ?"
        ).bind(
          crypto.randomUUID(),
          app,
          builder.userId,
          keyOf(),
          Date.now() - 120_000,
          Date.now() - 60_000,
          handle.runId
        ),
      ]);
      await tellQueryFollowers(env, handle.runId);
      await vi.waitFor(() => {
        expect(
          channel.peekRun(handle.runId).value?.control.pendingControl
        ).toStrictEqual({ kind: "pause", stage: "applying" });
      }, settles);
      const applying = channel.peekRun(handle.runId);
      await repairResourceTerminations(env, new Date());
      await vi.waitFor(() => {
        const shown = channel.peekRun(handle.runId).value;
        expect(shown?.status).toBe("paused");
        expect(shown?.control.pendingControl).toBeNull();
      }, settles);
      const paused = channel.peekRun(handle.runId);
      stopRun();

      expect({
        later: paused.revision > applying.revision,
        state: await env.DB.prepare(
          "SELECT state FROM workflow_resource_run_controls WHERE run_id = ?"
        )
          .bind(handle.runId)
          .first<string>("state"),
      }).toStrictEqual({ later: true, state: "applied" });
    });

    it("refuses a cancel of a run that completed", async () => {
      const { builder, app, reference } = await boundApp();
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("completed");
      }, settles);
      stopRun();
      await expect(
        refusalOf(
          channel.control(handle.runId, "cancel", () => {
            // Never recovering.
          })
        )
      ).resolves.toBe("workflow.control_refused");
    });

    it("shows a run only to the person the App started it for: another member of the App, an admin and a made-up ID see none", async () => {
      const { builder, admin, app, reference } = await boundApp({
        hold: "1 hour",
      });
      const colleague = await signedIn("builder");
      await env.DB.prepare(
        "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
      )
        .bind(app, colleague.userId, builder.userId, Date.now())
        .run();
      const lease = await pageOf(builder, app);
      const handle = await pageRuns(builder, app, lease, reference).start({
        who: "Ada",
      });
      const seenBy = async (person: Person, runId: string) => {
        const watched = await following(
          person,
          app,
          await pageOf(person, app),
          workflowQuery(reference, "run", { runId })
        );
        await vi.waitFor(() => {
          expect(watched.received.length).toBeGreaterThan(0);
        }, settles);
        await watched.subscription.release();
        return watched.received[0]?.outcome;
      };
      const cancelBy = async (person: Person) =>
        outcomeOf(
          await called(
            person,
            app,
            await pageOf(person, app),
            controlCommand(reference, "cancel", handle.runId, keyOf())
          )
        );

      expect({
        colleague: await seenBy(colleague, handle.runId),
        admin: await seenBy(admin, handle.runId),
        madeUp: await seenBy(builder, crypto.randomUUID()),
        colleagueCancels: await cancelBy(colleague),
        adminCancels: await cancelBy(admin),
      }).toStrictEqual({
        // Not seen, alike whether it exists: nothing of it shown.
        colleague: null,
        admin: null,
        madeUp: null,
        colleagueCancels: "workflow.run_unavailable",
        adminCancels: "workflow.run_unavailable",
      });
    });

    it("refuses a mutation of a workflow the release doesn't declare or doesn't have, input the declaration doesn't take, a query sent as a mutation and a mutation followed as a query, starting nothing", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const startWatched = await following(builder, app, lease, {
        reference: {
          name: `${reference.contractId}.mutations.start`,
          kind: "query",
        },
        input: { input: { who: "Ada" } },
      });
      await vi.waitFor(() => {
        expect(startWatched.received.length).toBeGreaterThan(0);
      }, settles);
      await startWatched.subscription.release();
      const startOf = async (request: string) =>
        outcomeOf(await called(builder, app, lease, request));

      expect({
        unknownAlias: await startOf(
          startCommand({ contractId: "workflows.other" })
        ),
        unknownMutation: await startOf(
          JSON.stringify({
            reference: {
              name: `${reference.contractId}.mutations.restart`,
              kind: "mutation",
            },
            input: { runId: "run-1" },
            idempotencyKey: keyOf(),
          })
        ),
        badInput: await startOf(startCommand(reference, { who: " " })),
        inputNotUnderInput: await startOf(
          mutationCall(reference, "start", { who: "Ada" })
        ),
        // Keyed as the App's own mutations are: 1 to 128 printable ASCII.
        badKeys: await Promise.all(
          ["", "k".repeat(129), "line\nbreak"].map(
            async (key) =>
              await startOf(startCommand(reference, { who: "Ada" }, key))
          )
        ),
        queryAsMutation: await startOf(
          JSON.stringify({
            reference: {
              name: `${reference.contractId}.queries.canStart`,
              kind: "mutation",
            },
            input: {},
            idempotencyKey: keyOf(),
          })
        ),
        mutationAsQuery: startWatched.received[0]?.outcome,
        runs: await env.DB.prepare(
          "SELECT COUNT(*) AS runs FROM workflow_start_receipts WHERE invoker_id = ?"
        )
          .bind(app)
          .first<number>("runs"),
      }).toStrictEqual({
        unknownAlias: "function.not_found",
        unknownMutation: "function.not_found",
        badInput: "contract.invalid_args",
        inputNotUnderInput: "contract.invalid_args",
        badKeys: Array.from({ length: 3 }, () => "submission.key_invalid"),
        queryAsMutation: "function.kind_mismatch",
        mutationAsQuery: "function.not_found",
        runs: 0,
      });
    });

    it("offers nothing once the App's start grant is revoked, and refuses its starts and cancels then", async () => {
      const { builder, admin, app, grant, reference } = await boundApp({
        hold: "1 hour",
      });
      const lease = await pageOf(builder, app);
      const handle = await pageRuns(builder, app, lease, reference).start({
        who: "Ada",
      });
      await revokePermission(env, admin.acting, grant);
      // A page that follows them now: a fresh client, as a new tab's.
      const channel = pageRuns(builder, app, lease, reference);
      const stopBinding = channel.followBinding(() => {
        // Read below.
      });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekBinding().value).toBeDefined();
        expect(channel.peekRun(handle.runId).value).toBeDefined();
      }, settles);
      const offered = {
        canRun: channel.peekBinding().value?.canRun,
        canCancel: channel.peekRun(handle.runId).value?.control.canCancel,
      };
      stopBinding();
      stopRun();

      expect({
        offered,
        start: await refusalOf(channel.start({ who: "Ada" })),
        cancel: await refusalOf(
          channel.control(handle.runId, "cancel", () => {
            // Never recovering.
          })
        ),
      }).toStrictEqual({
        offered: { canRun: false, canCancel: false },
        start: "workflow.start_denied",
        cancel: "workflow.start_denied",
      });
    });

    it("starts and shows nothing of another version the alias was bound to since the seal", async () => {
      const fixture = await boundApp({ hold: "1 hour" });
      const { builder, app, reference } = fixture;
      const lease = await pageOf(builder, app);
      const handle = await pageRuns(builder, app, lease, reference).start({
        who: "Ada",
      });
      // Version 2, bound with no seal: the release's references were made
      // for version 1.
      await publishWorkflowVersion(env, builder.acting, fixture.workflow, {
        definition: greetingOf(undefined, "Version 2"),
        basedOn: 1,
      });
      await bindWorkflowToApp(env, builder.acting, fixture.workflow, {
        app,
        alias: "followUp",
        version: 2,
      });
      const channel = pageRuns(builder, app, lease, reference);
      const stopBinding = channel.followBinding(() => {
        // Read below.
      });
      const watched = await following(
        builder,
        app,
        lease,
        workflowQuery(reference, "run", { runId: handle.runId })
      );
      await vi.waitFor(() => {
        expect(channel.peekBinding().value).toBeDefined();
        expect(watched.received.length).toBeGreaterThan(0);
      }, settles);
      const { canRun } = channel.peekBinding().value ?? {};
      stopBinding();
      await watched.subscription.release();

      expect({
        canRun,
        run: watched.received[0]?.outcome,
        start: await refusalOf(channel.start({ who: "Ada" })),
      }).toStrictEqual({
        canRun: false,
        run: null,
        start: "workflow.start_denied",
      });
    });

    it("tells a page already following a run as the App's start grant is revoked and given again", async () => {
      const fixture = await boundApp({ hold: "1 hour" });
      const { builder, admin, app, reference } = fixture;
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stop = channel.followRun(handle.runId, () => {
        // Read below.
      });
      const canCancel = () =>
        channel.peekRun(handle.runId).value?.control.canCancel;
      await vi.waitFor(() => {
        expect(canCancel()).toBeTruthy();
      }, settles);
      await revokePermission(env, admin.acting, fixture.grant);
      await vi.waitFor(() => {
        expect(canCancel()).toBeFalsy();
      }, settles);
      const asked = await builder.api.permissions.request({
        subject: { type: "app", appId: app },
        object: { type: "workflow", workflowId: fixture.workflow },
        actions: ["start"],
        binding: "FOLLOW_UP",
      });
      await grantReviewed(admin.api, asked.id);
      await vi.waitFor(() => {
        expect(canCancel()).toBeTruthy();
      }, settles);
      stop();
    });

    it("never shows a run as cancellable in a read the grant's revocation landed in", async () => {
      const fixture = await boundApp({ hold: "1 hour" });
      const { builder, admin, app, reference } = fixture;
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stop = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(
          channel.peekRun(handle.runId).value?.control.canCancel
        ).toBeTruthy();
      }, settles);
      // The revocation lands while a snapshot is being read.
      const inFlight = await callOn(
        racingRunRead(async () => {
          await revokePermission(env, admin.acting, fixture.grant);
        }),
        builder,
        app,
        queryCall(reference, "run", { runId: handle.runId })
      );
      await vi.waitFor(() => {
        expect(
          channel.peekRun(handle.runId).value?.control.canCancel
        ).toBeFalsy();
      }, settles);
      stop();
      expect(
        z
          .object({ control: z.object({ canCancel: z.boolean() }) })
          .parse(inFlight).control.canCancel
      ).toBeFalsy();
    });

    it("refuses what a run returned when it is more than the App declares", async () => {
      const { builder, app, reference } = await boundApp({
        definition: widerOf,
      });
      const lease = await pageOf(builder, app);
      const handle = await pageRuns(builder, app, lease, reference).start({
        who: "Ada",
      });
      const watched = await following(
        builder,
        app,
        lease,
        workflowQuery(reference, "run", { runId: handle.runId })
      );
      await vi.waitFor(() => {
        expect(watched.received.at(-1)?.outcome).toBeTypeOf("string");
      }, settles);
      await watched.subscription.release();
      expect({
        shown: watched.received.at(-1)?.outcome,
        leaks: JSON.stringify(watched.received).includes("ultramarine"),
      }).toStrictEqual({ shown: "contract.invalid_return", leaks: false });
    });

    it("gives a second subscription to a run the revision the first already has", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const handle = await pageRuns(builder, app, lease, reference).start({
        who: "Ada",
      });
      const watch = workflowQuery(reference, "run", { runId: handle.runId });
      const first = await following(builder, app, lease, watch);
      await vi.waitFor(() => {
        expect(shownOf(first.received.at(-1)?.outcome)).toBe("running");
      }, settles);
      // The same run on the same connection: one reading, shared.
      const second = await following(builder, app, lease, watch);
      await vi.waitFor(() => {
        expect(second.received.length).toBeGreaterThan(0);
      }, settles);
      await first.subscription.release();
      await second.subscription.release();
      expect(second.received.map(({ revision }) => revision)).toStrictEqual([
        first.received.at(-1)?.revision,
      ]);
    });

    it("shows nothing of a run and offers no start once the alias is rebound, then shows both again once rebound back, with nothing else changing", async () => {
      const fixture = await boundApp({ hold: "1 hour" });
      const { builder, app, reference } = fixture;
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const watched = await channel.start({ who: "Ada" });
      const watch = workflowQuery(reference, "run", { runId: watched.runId });
      const first = await following(builder, app, lease, watch);
      const binding = await following(
        builder,
        app,
        lease,
        workflowQuery(reference, "canStart", {})
      );
      const canRun = () =>
        z.boolean().safeParse(binding.received.at(-1)?.outcome).data;
      await vi.waitFor(() => {
        expect(shownOf(first.received.at(-1)?.outcome)).toBe("running");
        expect(waitsShown(first.received.at(-1)?.outcome)).toBe(1);
        expect(canRun()).toBeTruthy();
      }, settles);
      // Rebound away: the page is told at once, nothing else needed.
      await publishWorkflowVersion(env, builder.acting, fixture.workflow, {
        definition: greetingOf("1 hour", "Version 2"),
        basedOn: 1,
      });
      await bindWorkflowToApp(env, builder.acting, fixture.workflow, {
        app,
        alias: "followUp",
        version: 2,
      });
      await vi.waitFor(() => {
        expect(first.received.at(-1)?.outcome).toBeNull();
        expect(canRun()).toBeFalsy();
      }, settles);
      // Bound back: shown again, at the same stage, and startable again.
      await bindWorkflowToApp(env, builder.acting, fixture.workflow, {
        app,
        alias: "followUp",
        version: 1,
      });
      await vi.waitFor(() => {
        expect(shownOf(first.received.at(-1)?.outcome)).toBe("running");
        expect(canRun()).toBeTruthy();
      }, settles);
      const second = await following(builder, app, lease, watch);
      await vi.waitFor(() => {
        expect(second.received.length).toBeGreaterThan(0);
      }, settles);
      await first.subscription.release();
      await second.subscription.release();
      await binding.subscription.release();
      expect({
        // What it showed in turn, each read again as the binding changed,
        // from the run running on (it may first have shown it queued).
        first: first.received
          .map(({ outcome: shown }) => shownOf(shown))
          .filter((shown) => shown !== "queued")
          .filter((shown, at, all) => at === 0 || shown !== all[at - 1]),
        // The same push to a page that only now asks: one read, shared.
        sameRevision: new Set([
          first.received.at(-1)?.revision,
          second.received.at(0)?.revision,
        ]).size,
        second: second.received.map(({ outcome: shown }) => shownOf(shown)),
      }).toStrictEqual({
        first: ["running", "unavailable", "running"],
        sameRevision: 1,
        second: ["running"],
      });
    });

    it("answers a page that subscribes after a run's output passed its retention with no output, whatever another page still shows", async () => {
      const { builder, app, reference } = await boundApp();
      const lease = await pageOf(builder, app);
      const handle = await pageRuns(builder, app, lease, reference).start({
        who: "Ada",
      });
      const watch = workflowQuery(reference, "run", { runId: handle.runId });
      const first = await following(builder, app, lease, watch);
      await vi.waitFor(() => {
        expect(shownOf(first.received.at(-1)?.outcome)).toBe("completed");
      }, settles);
      // Its details removed, as the retention sweep removes them.
      await env.DB.prepare(
        "UPDATE workflow_start_receipts SET details_removed_at = ?, input = NULL, params = NULL WHERE id = ?"
      )
        .bind(Date.now(), handle.runId)
        .run();
      const second = await following(builder, app, lease, watch);
      await vi.waitFor(() => {
        expect(second.received.length).toBeGreaterThan(0);
      }, settles);
      await first.subscription.release();
      await second.subscription.release();
      expect({
        second: second.received.map(({ outcome: shown }) => shown),
        leaks: JSON.stringify(second.received).includes("Hello, Ada"),
      }).toStrictEqual({
        second: ["workflow.run_details_removed"],
        leaks: false,
      });
    });

    it("shows nothing of a page's run while its alias is bound elsewhere, and the run again once bound back", async () => {
      const fixture = await boundApp({ hold: "1 hour" });
      const { builder, app, reference } = fixture;
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const watched = await channel.start({ who: "Ada" });
      const other = await channel.start({ who: "Bo" });
      const stopRun = channel.followRun(watched.runId, () => {
        // Read below.
      });
      const shown = () => channel.peekRun(watched.runId);
      await vi.waitFor(() => {
        expect(shown().value?.status).toBe("running");
      }, settles);
      const before = shown();
      // Bound away: the next read, which another run's end causes, shows
      // nothing of it.
      await publishWorkflowVersion(env, builder.acting, fixture.workflow, {
        definition: greetingOf("1 hour", "Version 2"),
        basedOn: 1,
      });
      await bindWorkflowToApp(env, builder.acting, fixture.workflow, {
        app,
        alias: "followUp",
        version: 2,
      });
      await terminateResourceRun(
        env,
        builder.acting,
        fixture.workflow,
        other.runId
      );
      await vi.waitFor(() => {
        expect(shown().value).toBeNull();
      }, settles);
      const away = shown();
      // Bound back, and read again as a new run starts: shown again.
      await bindWorkflowToApp(env, builder.acting, fixture.workflow, {
        app,
        alias: "followUp",
        version: 1,
      });
      await channel.start({ who: "Cy" });
      await vi.waitFor(() => {
        expect(shown().value).not.toBeNull();
      }, settles);
      const back = shown();
      stopRun();

      expect({
        before: before.value?.control,
        // Losing it is a state, no error.
        away: { value: away.value, error: away.error },
        back: back.value?.control,
      }).toStrictEqual({
        before: {
          canPause: true,
          canResume: false,
          canCancel: true,
          pendingControl: null,
        },
        away: { value: null, error: undefined },
        back: before.value?.control,
      });
    });

    it("shows a failed run only a code the platform defines, in its own words, never what the run read", async () => {
      const { builder, app, reference } = await boundApp({
        definition: failingOf,
      });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stop = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("failed");
      }, settles);
      const { error } = channel.peekRun(handle.runId).value ?? {};
      stop();
      // A code the platform defines, in the platform's own words: nothing
      // of what the run read.
      expect({
        code: error?.code,
        message: error?.message,
        leaks: JSON.stringify(error).includes("Ada"),
      }).toStrictEqual({
        code: "expression.failed",
        message: expectedMessageOf("expression.failed"),
        leaks: false,
      });
    });

    it("words any failure the platform doesn't define as a step's, whatever the workflow said", () => {
      const stepFailed = {
        code: "workflow.step_failed",
        message: expectedMessageOf("workflow.step_failed"),
      };
      expect({
        ownCode: failureShown({
          code: "test.secret",
          message: "The secret is 42.",
        }),
        inANamespace: failureShown({
          code: "workflow.secret_42",
          message: "The secret is 42.",
        }),
        none: failureShown({ code: null, message: "The secret is 42." }),
        platform: failureShown({
          code: "expression.failed",
          message: "It read Ada's salary.",
        }),
      }).toStrictEqual({
        ownCode: stepFailed,
        inANamespace: stepFailed,
        none: stepFailed,
        platform: {
          code: "expression.failed",
          message: expectedMessageOf("expression.failed"),
        },
      });
    });

    it("shows what a restricted run returned only through an App still in restricted mode", async () => {
      const { builder, app, reference } = await boundApp();
      // Restricted as the start is decided, so its run is restricted for good.
      await appHost(env, appIdSchema.parse(app)).restrict();
      const lease = await pageOf(builder, app);
      const handle = await pageRuns(builder, app, lease, reference).start({
        who: "Ada",
      });
      const shownOnce = async () => {
        const watched = await following(
          builder,
          app,
          lease,
          workflowQuery(reference, "run", { runId: handle.runId })
        );
        // Until it shows the run ended, or is refused.
        await vi.waitFor(() => {
          const last = watched.received.at(-1);
          expect(
            typeof last?.outcome === "string" ||
              ["completed", "failed", "cancelled"].includes(
                String(shownOf(last?.outcome))
              )
          ).toBeTruthy();
        }, settles);
        await watched.subscription.release();
        const shown = watched.received.at(-1)?.outcome;
        return typeof shown === "string"
          ? shown
          : z.object({ output: z.unknown() }).parse(shown).output;
      };
      const restricted = await shownOnce();
      // As only a write around the platform could: the App out of it again.
      await runInDurableObject(
        appHost(env, appIdSchema.parse(app)),
        async (_instance, state) => {
          await state.storage.delete("restricted");
        }
      );
      expect({ restricted, unrestricted: await shownOnce() }).toStrictEqual({
        restricted: { status: "Hello, Ada" },
        unrestricted: "permission.restricted",
      });
    });

    it("shows App B nothing of App A's run of the same workflow, and refuses its cancel", async () => {
      const appA = await boundApp({ hold: "1 hour" });
      const appB = await boundApp({ sharing: appA.sharing });
      const { builder } = appA;
      const leaseA = await pageOf(builder, appA.app);
      const handle = await pageRuns(
        builder,
        appA.app,
        leaseA,
        appA.reference
      ).start({ who: "Ada" });
      const leaseB = await pageOf(builder, appB.app);
      const watched = await following(
        builder,
        appB.app,
        leaseB,
        workflowQuery(appB.reference, "run", { runId: handle.runId })
      );
      await vi.waitFor(() => {
        expect(watched.received.length).toBeGreaterThan(0);
      }, settles);
      await watched.subscription.release();
      expect({
        seen: watched.received[0]?.outcome,
        cancel: outcomeOf(
          await called(
            builder,
            appB.app,
            leaseB,
            controlCommand(appB.reference, "cancel", handle.runId, keyOf())
          )
        ),
      }).toStrictEqual({
        seen: null,
        cancel: "workflow.run_unavailable",
      });
    });

    it("refuses an App's workflows to its own server code's callers", async () => {
      const { builder, app, reference } = await boundApp({
        hold: "1 hour",
      });
      const start = startCommand(reference, { who: "Ada" });
      expect({
        // An agent's or another App's call of the App, as its server takes it:
        // a workflow's mutations, and the run and whether one may start, are
        // a page's alone, no function of the App's.
        agent: outcomeOf(
          await callAppFunction(env, builder.acting, app, start)
        ),
        read: await Promise.all(
          [
            queryCall(reference, "run", { runId: "run-1" }),
            queryCall(reference, "canStart", {}),
          ].map(async (read) =>
            outcomeOf(await callAppFunction(env, builder.acting, app, read))
          )
        ),
        runs: await env.DB.prepare(
          "SELECT COUNT(*) AS runs FROM workflow_start_receipts WHERE invoker_id = ?"
        )
          .bind(app)
          .first<number>("runs"),
      }).toStrictEqual({
        agent: "function.not_found",
        read: ["function.not_found", "function.not_found"],
        runs: 0,
      });
    });

    it("fences a page whose release was revoked at its run's next change", async () => {
      const fixture = await boundApp({ hold: "1 hour" });
      const { builder, app, reference } = fixture;
      const { lease, version } = await builder.api.pages.open(app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stop = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("running");
      }, settles);
      await revokeRelease(
        env,
        await actingPerson("admin"),
        { app: appIdSchema.parse(app), version },
        "Leaks data"
      );
      await terminateResourceRun(
        env,
        builder.acting,
        fixture.workflow,
        handle.runId
      );
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).error?.code).toBe("page.revoked");
      }, settles);
      const fenced = channel.peekRun(handle.runId);
      stop();
      expect({ value: fenced.value, code: fenced.error?.code }).toStrictEqual({
        value: undefined,
        code: "page.revoked",
      });
    });

    it("applies a cancel whose stop never went out at the next repair, settling its receipt", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stop = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("running");
      }, settles);
      // Admitted a while ago, its request ended before it asked the engine.
      await env.DB.prepare(
        "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, created_at, next_at) VALUES (?, ?, ?, ?, ?, 'cancel', 'admitted', ?, ?)"
      )
        .bind(
          crypto.randomUUID(),
          handle.runId,
          app,
          builder.userId,
          keyOf(),
          Date.now() - 120_000,
          Date.now() - 60_000
        )
        .run();
      const events = await auditedDuring(async () => {
        await repairResourceTerminations(env, new Date());
        await vi.waitFor(() => {
          expect(channel.peekRun(handle.runId).value?.status).toBe("cancelled");
        }, settles);
        // A repair again, well after: nothing more is stopped or audited.
        await repairResourceTerminations(env, new Date(Date.now() + 3_600_000));
      });
      stop();
      expect({
        state: await env.DB.prepare(
          "SELECT state FROM workflow_resource_run_controls WHERE run_id = ?"
        )
          .bind(handle.runId)
          .first<string>("state"),
        // The stop audited once, under the App's page, for the person.
        terminated: events
          .filter(
            ({ action, target }) =>
              action === "workflow.run.terminated" &&
              target?.id === handle.runId
          )
          .map(({ actor, detail }) => ({
            actor,
            onBehalfOf: detail.onBehalfOf,
          })),
      }).toStrictEqual({
        state: "applied",
        terminated: [
          {
            actor: { type: "app", appId: app, part: "page" },
            onBehalfOf: builder.userId,
          },
        ],
      });
    });

    it("cancels a run the engine refuses to terminate at once: it runs nothing more, and ends cancelled with its receipt applied, with no repair", async () => {
      // Its wait is over well before a minute's repair would come.
      const { builder, app, reference } = await boundApp({ hold: "2 seconds" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stop = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await sleeping(handle.runId, "hold:task");
      const events = await auditedDuring(async () => {
        const answered = await whileEngineRefuses(
          (method) => method === "terminate",
          async () =>
            await channel.control(handle.runId, "cancel", () => {
              // Never recovering.
            })
        );
        expect(staged(answered)).toStrictEqual({
          kind: "cancel",
          state: "admitted",
        });
        // No repair of core's runs: the run's own object ends it.
        await vi.waitFor(() => {
          expect(channel.peekRun(handle.runId).value?.status).toBe("cancelled");
        }, settles);
        // And past its wait again: it never comes back.
        await scheduler.wait(2500);
      });
      const shown = channel.peekRun(handle.runId).value;
      stop();
      expect({
        shown: { status: shown?.status, output: shown?.output },
        receipt: await env.DB.prepare(
          "SELECT state FROM workflow_resource_run_controls WHERE run_id = ?"
        )
          .bind(handle.runId)
          .first<string>("state"),
        ended: events
          .filter(
            ({ action, target }) =>
              [
                "workflow.run.completed",
                "workflow.run.cancelled",
                "workflow.run.terminated",
              ].includes(action) && target?.id === handle.runId
          )
          .map(({ action, actor }) => ({ action, actor })),
      }).toStrictEqual({
        shown: { status: "cancelled", output: undefined },
        receipt: "applied",
        ended: [
          { action: "workflow.run.cancelled", actor: { type: "system" } },
          {
            action: "workflow.run.terminated",
            actor: { type: "app", appId: app, part: "page" },
          },
        ],
      });
    });

    it("settles a cancel as superseded, auditing no stop, when its run completed before the stop went out", async () => {
      const { builder, app, reference } = await boundApp();
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stop = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("completed");
      }, settles);
      stop();
      // Admitted while it ran, its request ended before it asked the engine.
      await env.DB.prepare(
        "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, created_at, next_at) VALUES (?, ?, ?, ?, ?, 'cancel', 'admitted', ?, ?)"
      )
        .bind(
          crypto.randomUUID(),
          handle.runId,
          app,
          builder.userId,
          keyOf(),
          Date.now() - 120_000,
          Date.now() - 60_000
        )
        .run();
      const events = await auditedDuring(async () => {
        await repairResourceTerminations(env, new Date());
      });
      expect({
        state: await env.DB.prepare(
          "SELECT state FROM workflow_resource_run_controls WHERE run_id = ?"
        )
          .bind(handle.runId)
          .first<string>("state"),
        terminated: events.filter(
          ({ action, target }) =>
            action === "workflow.run.terminated" && target?.id === handle.runId
        ).length,
      }).toStrictEqual({ state: "superseded", terminated: 0 });
    });

    it("starts one run for a key sent twice at once, and keeps one cancel receipt for a run however many keys ask, never changed after", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const start = startCommand(reference, { who: "Ada" });
      const [one, two] = await Promise.all([
        called(builder, app, lease, start),
        called(builder, app, lease, start),
      ]);
      const handle = z.object({ runId: z.string() }).parse(outcomeOf(one));
      const cancel = () =>
        controlCommand(reference, "cancel", handle.runId, keyOf());
      const cancels = await Promise.all([
        called(builder, app, lease, cancel()),
        called(builder, app, lease, cancel()),
      ]);
      const receipts = await env.DB.prepare(
        "SELECT id, state FROM workflow_resource_run_controls WHERE run_id = ?"
      )
        .bind(handle.runId)
        .all<{ id: string; state: string }>();
      const id = receipts.results[0]?.id ?? "";
      expect({
        same: outcomeOf(two),
        cancels: cancels.map((answer) => staged(outcomeOf(answer))),
        receipts: receipts.results.map(({ state }) => state),
        reopened:
          (await outcome(
            env.DB.prepare(
              "UPDATE workflow_resource_run_controls SET state = 'admitted', settled_at = NULL WHERE id = ?"
            )
              .bind(id)
              .run()
          )) === "ok",
        deleted:
          (await outcome(
            env.DB.prepare(
              "DELETE FROM workflow_resource_run_controls WHERE id = ?"
            )
              .bind(id)
              .run()
          )) === "ok",
      }).toStrictEqual({
        same: outcomeOf(one),
        cancels: [
          { kind: "cancel", state: "applied" },
          { kind: "cancel", state: "applied" },
        ],
        receipts: ["applied"],
        reopened: false,
        deleted: false,
      });
    });
  }
);

// A run whose engine rolls its steps back (spec 10.7.3), on the real
// engine with a test's definition (rollbacks.ts): no definition Grasp
// builds registers a rollback yet (GRA-984).
describe(
  "a page's typed workflow run while it compensates",
  { timeout: 120_000 },
  () => {
    afterEach(endLiveResourceRuns);

    withRollbacks();

    /**
     * A run of the Requests App's `followUp`, its next activation the
     * test's (`compensated`), followed through its compensation: what the
     * page saw while the engine rolled it back, and as it ended.
     */
    const compensatedRun = async (
      compensated: Omit<Parameters<typeof rollingBackRun>[1], "holds" | "held">,
      end?: (runId: string) => Promise<void>,
      /** What is asked of it while it compensates: answered as `during`. */
      meanwhile?: (asked: {
        channel: ReturnType<typeof pageRuns>;
        runId: string;
        builder: Person;
        workflow: string;
      }) => Promise<unknown>
    ) => {
      const { builder, app, reference, workflow } = await boundApp({
        hold: "1 hour",
      });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      await sleeping(handle.runId, "hold:task");
      const holds = gate();
      rollingBackRun(handle.runId, {
        ...compensated,
        holds,
        // Its `hold` task's hour.
        held: { name: "hold:task", ms: 3_600_000 },
      });
      const stop = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await woken(handle.runId, "hold:task");
      await end?.(handle.runId);
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe(
          "compensating"
        );
      }, settles);
      const compensating = channel.peekRun(handle.runId);
      const during = await meanwhile?.({
        channel,
        runId: handle.runId,
        builder,
        workflow,
      });
      holds.open();
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.finishedAt).not.toBeNull();
      }, settles);
      const ended = channel.peekRun(handle.runId);
      stop();
      return {
        during,
        compensating: {
          status: compensating.value?.status,
          compensation: compensating.value?.compensation,
          finishedAt: compensating.value?.finishedAt,
          canCancel: compensating.value?.control.canCancel,
          canPause: compensating.value?.control.canPause,
        },
        ended: {
          status: ended.value?.status,
          error: ended.value?.error?.code,
        },
      };
    };

    it("shows a failed run compensating with what it failed with, then failed with that once its compensation is done", async () => {
      await expect(
        compensatedRun({ ends: { fails: "resource.declined" } })
      ).resolves.toStrictEqual({
        during: undefined,
        compensating: {
          status: "compensating",
          compensation: {
            cause: "failure",
            activity: "running",
            originalError: {
              code: "resource.declined",
              message: expectedMessageOf("resource.declined"),
              category: "domain",
              retryable: false,
              requestId: null,
            },
          },
          // Not ended while its compensation runs.
          finishedAt: null,
          canCancel: false,
          canPause: false,
        },
        ended: { status: "failed", error: "resource.declined" },
      });
    });

    it("ends a run whose compensation failed as workflow.compensation_failed", async () => {
      const shown = await compensatedRun({
        ends: { fails: "resource.declined" },
        rollbackFails: true,
      });
      expect(shown.ended).toStrictEqual({
        status: "failed",
        error: "workflow.compensation_failed",
      });
    });

    it("shows a run cancelled with a rollback compensating for its cancellation, then cancelled", async () => {
      const shown = await compensatedRun({ ends: "sleeps" }, async (runId) => {
        await sleeping(runId, "after-charge");
        await runInstance(runId).terminate({ rollback: true });
      });
      expect({
        compensation: shown.compensating.compensation,
        ended: shown.ended,
      }).toStrictEqual({
        compensation: { cause: "cancellation", activity: "running" },
        ended: { status: "cancelled", error: undefined },
      });
    });

    it("ends a cancelled run whose compensation failed as workflow.compensation_failed, though a stop comes before its end is told", async () => {
      const { builder, app, reference, workflow } = await boundApp({
        hold: "1 hour",
      });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const { runId } = await channel.start({ who: "Ada" });
      await sleeping(runId, "hold:task");
      const holds = gate();
      rollingBackRun(runId, {
        ends: "sleeps",
        rollbackFails: true,
        holds,
        held: { name: "hold:task", ms: 3_600_000 },
      });
      await woken(runId, "hold:task");
      await sleeping(runId, "after-charge");
      const release = heldEnd(runId);
      await runInstance(runId).terminate({ rollback: true });
      holds.open();
      // Ended in the engine, its refund failed; core not told of it yet.
      await vi.waitFor(async () => {
        await expect(runInstance(runId).status()).resolves.toMatchObject({
          status: "terminated",
          rollback: { status: "errored" },
        });
      }, settles);
      const rowOf = async () =>
        await env.DB.prepare(
          "SELECT status, failure_code AS failureCode FROM workflow_resource_runs WHERE id = ?"
        )
          .bind(runId)
          .first<{ status: string; failureCode: string | null }>();
      const before = await rowOf();
      await terminateResourceRun(env, builder.acting, workflow, runId);
      const stopped = await rowOf();
      release();
      expect({ before: before?.status, stopped }).toStrictEqual({
        before: "running",
        // Ended as the engine has it: an ended row never changes again,
        // so the late end can't put a failed compensation right.
        stopped: {
          status: "failed",
          failureCode: "workflow.compensation_failed",
        },
      });
    });

    it("audits a cancel admitted just before its run began to compensate as nothing terminated, and notes no stop", async () => {
      let seen:
        | {
            answered: { kind: string; state: string } | undefined;
            terminated: number;
            runId: string;
          }
        | undefined;
      const shown = await compensatedRun(
        { ends: { fails: "resource.declined" } },
        undefined,
        async ({ channel, runId }) => {
          // The engine's word is lost as the cancel is admitted, as when
          // its rollback began right after: the cancel goes ahead, and the
          // engine answers that it rolls back.
          const spy = vi
            .spyOn(WorkflowRuns.prototype, "status")
            .mockImplementationOnce(() => {
              throw new Error("The engine couldn't say");
            });
          let answered: { kind: string; state: string } | undefined;
          const events = await auditedDuring(async () => {
            const { kind, state } = await channel.control(
              runId,
              "cancel",
              () => {
                // Never recovering.
              }
            );
            answered = { kind, state };
          });
          spy.mockRestore();
          seen = {
            answered,
            terminated: events.filter(
              ({ action }) => action === "workflow.run.terminated"
            ).length,
            runId,
          };
        }
      );
      const runId = seen?.runId ?? "";
      const receipt = await env.DB.prepare(
        "SELECT state FROM workflow_resource_run_controls WHERE run_id = ?"
      )
        .bind(runId)
        .first<string>("state");
      const events = await allEvents();
      const terminated = events.filter(
        ({ action, target }) =>
          action === "workflow.run.terminated" && target?.id === runId
      ).length;
      expect({
        during: {
          answered: seen?.answered,
          terminated: seen?.terminated,
        },
        ended: shown.ended,
        receipt,
        terminated,
      }).toStrictEqual({
        // Admitted, its stop not taken: nothing recorded as terminated.
        during: {
          answered: { kind: "cancel", state: "admitted" },
          terminated: 0,
        },
        // Its compensation ran to its end, never cut short.
        ended: { status: "failed", error: "resource.declined" },
        // Settled by the run's end, which no stop of its brought about.
        receipt: "superseded",
        terminated: 0,
      });
    });

    it("refuses a cancel or a stop while a run compensates, with no receipt and nothing audited as terminated", async () => {
      const shown = await compensatedRun(
        { ends: { fails: "resource.declined" } },
        undefined,
        async ({ channel, runId, builder, workflow }) => {
          let cancel: unknown;
          let stop: unknown;
          const events = await auditedDuring(async () => {
            cancel = await refusalOf(
              channel.control(runId, "cancel", () => {
                // Never recovering.
              })
            );
            stop = await refusalOf(
              terminateResourceRun(env, builder.acting, workflow, runId)
            );
          });
          const receipts = await env.DB.prepare(
            "SELECT count(*) AS n FROM workflow_resource_run_controls WHERE run_id = ?"
          )
            .bind(runId)
            .first<{ n: number }>();
          return {
            cancel,
            stop,
            receipts: receipts?.n,
            terminated: events.filter(
              ({ action }) => action === "workflow.run.terminated"
            ).length,
          };
        }
      );
      expect({ during: shown.during, ended: shown.ended }).toStrictEqual({
        during: {
          // The engine's own word that it rolls back, as every control's.
          cancel: "workflow.control_rolling_back",
          stop: "workflow.control_refused",
          receipts: 0,
          terminated: 0,
        },
        // Its compensation ran to its end, its failure as it failed.
        ended: { status: "failed", error: "resource.declined" },
      });
    });
  }
);
