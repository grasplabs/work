import { v } from "@grasp-os/sdk";
import { workflowResourceIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { decode } from "@grasp-os/workerflow/codec";
import type { EventMatch } from "@grasp-os/workerflow/contracts";
import { namedError } from "@grasp-os/workerflow/errors";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  approveWorkflowBinding,
  revokeWorkflowBinding,
} from "../src/workflow-bindings.ts";
import { generatedModule } from "../src/workflow-builds.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { eventTypeKey } from "../src/workflows/event-envelopes.ts";
import { RunHost, waitStepPrefix } from "../src/workflows/host.ts";
import type { HostHooks, RunStep } from "../src/workflows/host.ts";
import type { CallingRun } from "../src/workflows/resource-authority.ts";
import { loadedActivation, runOf } from "../src/workflows/resource-runs.ts";
import { admitRunEvent } from "../src/workflows/run-events.ts";
import type { RunEventDelivery } from "../src/workflows/run-events.ts";
import {
  attemptHostMethods,
  loadSealedIsolate,
  sealedMainModule,
  sealedMainModules,
} from "../src/workflows/sealed-isolate.ts";
import type { StepError } from "../src/workflows/sealed-isolate.ts";
import {
  sealedRun,
  sealedRunFrom,
  sealedRunStart,
} from "../src/workflows/sealed-run.ts";
import type {
  HostedSealedRun,
  SealedRunKind,
  SealedRunMemory,
} from "../src/workflows/sealed-run.ts";
import { endLiveResourceRuns, objectSchema } from "./json-workflow-apps.ts";
import { engineOfTest } from "./run-host.ts";
import { admittedFreely, liveStatus, runObject } from "./runs.ts";
import { moduleOf as harnessModuleOf } from "./sealed-run-harness.ts";
import { unique } from "./sign-in.ts";

// A sealed run's event waits on the run host (sealed-run.ts, host.ts's
// `listen`), from their threat model. The isolate runs the build's code,
// and anything there could ask anything; events reach a run only through
// its inbox (run-events.ts), admitted through an event binding its start
// froze. The ways an event wait can fail, each closed:
//
// - an event the isolate made up: the wait's outcome is the host's, from
//   the engine's own record of what it took; a task's own step recorded
//   as a plain step, or an event wait the build doesn't seal (another
//   task's, or one of no step at all), is refused as tampering;
// - an event for another run, through another binding, or of a type the
//   task doesn't name: the host waits on the run's own inbox, for the
//   engine's types of its sealed binding and types only, whatever the
//   isolate passes;
// - a binding the run's start didn't freeze, or whose approval went: the
//   wait is refused (`workflow.event_denied`), asked again on every wait;
// - an event taken twice, or a replay that waits otherwise: the engine
//   journals the event a wait took, and the deadline is from when the
//   wait was first reached, as recorded;
// - a wait without end: past its sealed timeout it answers that it timed
//   out; a test run's is held to its wait limit, which no catch takes.
//
// Each test runs a module of its own in a real isolate, under the sealed
// run's main module, against a real published workflow's sealed build, a
// real start's receipt and that run's real inbox, on the run host with an
// engine of the test's own whose waits take events from that inbox, as
// the engine's `waitForMatch` does: the oldest it hasn't taken matching
// one of the wait's entries.

const person = async (role: Role): Promise<Identity> => {
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).bind(userId, "Person", `${userId}@acme.test`, Date.now(), Date.now()),
    env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, ?, ?)"
    ).bind(crypto.randomUUID(), userId, role, Date.now()),
  ]);
  return {
    userId,
    email: `${userId}@acme.test`,
    name: "Person",
    role,
    teams: [],
    staff: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
};

const completed = "grasp.job.completed";
const failed = "grasp.job.failed";

/** How long each event wait waits, as sealed: five minutes. */
const timeoutMs = 300_000;

/** An event wait `id` through `binding` for `type`, five minutes at most. */
const listen = (
  id: string,
  type: string | string[],
  binding = "jobEvents"
) => ({
  id,
  type: "waitForEvent",
  events: binding,
  eventType: type,
  timeout: "5 minutes",
});

/**
 * A workflow on input `{ jobId }` whose run waits out its hour, then has
 * event waits `awaitJob` (a job's completion or failure through
 * `jobEvents`), `awaitAgain` (its completion), `awaitGuarded` (its
 * completion, in a try whose catch takes anything) and `awaitOther` (a
 * completion through `otherEvents`). Its bindings `jobEvents` and
 * `otherEvents` are of one job event contract, each approved.
 */
const eventWorkflow = async () => {
  const admin = await person("admin");
  const contract = `job-events-${unique()}`;
  const job = JSON.stringify(v.object({ note: v.string() }).descriptor);
  await publishCatalogContract(env, admin, {
    key: contract,
    kind: "event",
    events: {
      [completed]: { data: job, browser: false },
      [failed]: { data: job, browser: false },
    },
  });
  const workflow = await createWorkflowResource(
    env,
    admin,
    `waits-${unique()}`
  );
  await publishWorkflowVersion(env, admin, workflow.id, {
    definition: JSON.stringify({
      $schema: workflowSchemaUrl,
      args: objectSchema({ jobId: { kind: "string" } }),
      permissions: {
        events: { jobEvents: { contract }, otherEvents: { contract } },
      },
      steps: [
        { id: "linger", type: "wait", for: "1 hour" },
        listen("awaitJob", [completed, failed]),
        listen("awaitAgain", completed),
        {
          id: "guarded",
          type: "try",
          try: [listen("awaitGuarded", completed)],
          // Takes any error a catch may take.
          catch: {},
        },
        listen("awaitOther", completed, "otherEvents"),
      ],
    }),
    basedOn: null,
  });
  const approvals: Record<string, string> = {};
  for (const alias of ["jobEvents", "otherEvents"]) {
    // oxlint-disable-next-line no-await-in-loop -- two approvals, in turn
    const approval = await approveWorkflowBinding(env, admin, workflow.id, {
      alias,
      target: { kind: "event" },
      reviewed: { version: 1 },
    });
    approvals[alias] = approval.id;
  }
  return { admin, workflow, approvals };
};

type EventWorkflow = Awaited<ReturnType<typeof eventWorkflow>>;

/** A run of `sealed` its admin started, once it waits out its hour. */
const waitingRun = async ({ admin, workflow }: EventWorkflow) => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: admin },
    workflow.id,
    { version: 1, args: { jobId: "job-1" }, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  await vi.waitFor(
    async () => {
      await expect(liveStatus(runId)).resolves.toBe("waiting");
    },
    { timeout: 30_000, interval: 100 }
  );
  return runId;
};

/** Run `runId` as the dispatcher loads it, served on the run host. */
const sealedRunOf = async (runId: string): Promise<HostedSealedRun> => {
  const row = await runOf(env, runId);
  if (row === undefined) {
    throw new Error(`Run ${runId} has no row`);
  }
  const { run } = await loadedActivation(
    env,
    {
      workflow: workflowResourceIdSchema.parse(row.workflowResourceId),
      version: row.version,
      manifest: row.manifestHash,
    },
    runId
  );
  return sealedRunFrom(run);
};

/**
 * A module of the test's own whose run on input `{ jobId }` is `body`, on
 * the run host's engine by the names the test gives (sealed-run-harness.ts).
 */
const moduleOf = (body: string): string => harnessModuleOf(body);

/** Task `id`'s event wait, as generated code waits. */
const wait = (id: string): string =>
  `await step.listen(${JSON.stringify(id)}, { key: "task", description: "Its event" })`;

/** A delivery of a job event to `runId`, through `jobEvents` unless said. */
const delivery = (
  workflowId: string,
  runId: string,
  event: Partial<RunEventDelivery> & { note: string }
): RunEventDelivery => {
  const { note, ...rest } = event;
  return {
    workflowId,
    runId,
    binding: "jobEvents",
    type: completed,
    data: { note },
    key: unique(),
    source: "urn:grasp:test:sender",
    sender: "test",
    ...rest,
  };
};

/** What a wait asked the engine for. */
interface Asked {
  readonly name: string;
  readonly match: readonly EventMatch[];
  readonly until: number;
}

/** An engine of the test's own, as `engineOfTest`'s. */
type Engine = Pick<ReturnType<typeof engineOfTest>, "step" | "leaseOf">;

/**
 * The engine's own record of a run, as a later activation finds it: each
 * step's outcome by its name, and the events its waits took, by their
 * place in the run's inbox.
 */
interface Kept {
  readonly journal: Map<string, { ok: true; value: unknown } | { ok: false }>;
  /** What each wait asked for, which a replay must ask again exactly. */
  readonly waits: Map<string, string>;
  readonly taken: Set<number>;
}

const keptOfTest = (): Kept => ({
  journal: new Map(),
  waits: new Map(),
  taken: new Set(),
});

/**
 * An engine whose waits for an event take from run `runId`'s real inbox
 * the oldest event none took before that matches one of the wait's
 * entries (its engine type, and every attribute it names), and time out
 * at once when there is none; it journals each step in `kept`, so a
 * later activation replays what an earlier one ran.
 */
const inboxEngine = (
  runId: string,
  kept: Kept = keptOfTest(),
  asked: Asked[] = []
): Engine => {
  const { step, leaseOf } = engineOfTest();
  const replayed = async (
    name: string,
    run: () => Promise<unknown>
  ): Promise<unknown> => {
    const journaled = kept.journal.get(name);
    if (journaled?.ok === true) {
      return journaled.value;
    }
    if (journaled !== undefined) {
      throw namedError("WorkflowTimeoutError", "Execution timed out");
    }
    try {
      const value = await run();
      kept.journal.set(name, { ok: true, value });
      return value;
    } catch (error) {
      kept.journal.set(name, { ok: false });
      throw error;
    }
  };
  const taking: RunStep["waitForMatch"] = async (_name, { match }) => {
    const journal = await runObject(runId).journal();
    const event = journal?.events.find(
      (each) =>
        !kept.taken.has(each.seq) &&
        match.some(
          (entry) =>
            entry.type === each.type &&
            Object.entries(entry.attributes ?? {}).every(
              ([attribute, value]) =>
                z
                  .record(z.string(), z.string())
                  .parse(JSON.parse(each.attributes ?? "{}"))[attribute] ===
                value
            )
        )
    );
    if (event === undefined) {
      throw namedError("WorkflowTimeoutError", "Execution timed out");
    }
    kept.taken.add(event.seq);
    return {
      payload: decode(event.payload),
      timestamp: new Date(event.accepted_at),
    };
  };
  return {
    leaseOf: (key, attempt) => {
      const lease = leaseOf(key, attempt);
      // A newer activation's than the run's own, which a real admission
      // would otherwise take for one it superseded.
      return lease === undefined ? undefined : { ...lease, generation: 1000 };
    },
    step: {
      ...step,
      do: async (name, config, fn) =>
        await replayed(name, async () => await step.do(name, config, fn)),
      waitForMatch: async (name, options) => {
        asked.push({ name, ...options });
        // As the engine halts a replay that waits for anything else.
        const waited = JSON.stringify(options);
        if ((kept.waits.get(name) ?? waited) !== waited) {
          throw new Error(
            `Wait "${name}" asks otherwise than it was journaled`
          );
        }
        kept.waits.set(name, waited);
        return z
          .object({ payload: z.unknown(), timestamp: z.date() })
          .parse(await replayed(name, async () => await taking(name, options)));
      },
    },
  };
};

/** Memory of a run's tried-once calls and model calls, this test's own. */
const memoryOfTest = (): SealedRunMemory => {
  const sent = new Set<string>();
  const failures = new Map<string, StepError>();
  return {
    sentCalls: {
      markSent: (key, attempt) => {
        sent.add(`${attempt}:${key}`);
      },
      unmarkSent: (key, attempt) => {
        sent.delete(`${attempt}:${key}`);
      },
      sent: (key, attempt) => sent.has(`${attempt}:${key}`),
      keepFailure: (key, attempt, error) => {
        failures.set(`${attempt}:${key}`, error);
      },
      failureOf: (key, attempt) => failures.get(`${attempt}:${key}`),
    },
    modelCalls: { count: () => 0, keep: () => {} },
  };
};

const settledSchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({ message: z.string(), code: z.string().optional() }),
  }),
]);

/**
 * Runs `source` (`moduleOf`) as run `runId` of its sealed build on the run
 * host: what it ended with (its value, or its error's code), and what the
 * host refused as tampering.
 */
const ranAs = async (
  runId: string,
  source: string,
  {
    engine = inboxEngine(runId),
    calling,
    maxSleepMs,
  }: {
    engine?: Engine;
    /** What its calls go by, from what its start froze. */
    calling?: (frozen: CallingRun) => CallingRun;
    /** Its waits' limit, as a test run's. */
    maxSleepMs?: number;
  } = {}
) => {
  const loaded = await sealedRunOf(runId);
  const run = {
    ...loaded,
    ...(calling === undefined ? {} : { calling: calling(loaded.calling) }),
    ...(maxSleepMs === undefined ? {} : { maxSleepMs }),
  };
  const tampered: string[] = [];
  let kind: SealedRunKind | undefined;
  const host = new RunHost(
    env,
    engine.step,
    (controls) => {
      kind = sealedRun(env, run, memoryOfTest())(controls);
      return kind;
    },
    {
      stepFailed: () => {
        // The run's end says what failed.
      },
      leaseOf: engine.leaseOf,
      tampered: (error) => {
        tampered.push(error.code ?? error.message);
      },
      waiting: async () => {
        await Promise.resolve();
      },
      admitAttempt: admittedFreely satisfies NonNullable<
        HostHooks["admitAttempt"]
      >,
    }
  );
  const code = loadSealedIsolate(env, {
    owner: `test:${runId}`,
    mainModule: sealedMainModule,
    modules: async () =>
      await Promise.resolve({
        ...run.build.sdk,
        [generatedModule]: source,
        ...sealedMainModules({
          module: generatedModule,
          refusal: "No workflow.",
        }),
      }),
    attemptHostMethods,
  });
  const settled = settledSchema.parse(
    await code.run(host, await sealedRunStart(env, run))
  );
  return {
    ended: settled.ok ? settled.value : settled.error.code,
    tampered,
    // A failure no catch may take, as the run's code ended well past it.
    ...(settled.ok && kind?.failureUntaken !== undefined
      ? { untaken: kind.failureUntaken.code }
      : {}),
  };
};

/** A refusal that ends the run as tampering. */
const refused = { ended: "workflow.invalid", tampered: ["workflow.invalid"] };

describe(
  "a sealed run's event waits on the run host",
  { timeout: 120_000 },
  () => {
    let sealed: EventWorkflow;

    beforeAll(async () => {
      sealed = await eventWorkflow();
    });

    afterAll(endLiveResourceRuns);

    it("takes the first event of one of its sealed types through its own binding from its run's own inbox, as the host minted it", async () => {
      const { workflow } = sealed;
      const runId = await waitingRun(sealed);
      // A run of the same workflow: an event sent to it is its own.
      const otherRun = await waitingRun(sealed);
      for (const event of [
        delivery(workflow.id, otherRun, { note: "another run's" }),
        delivery(workflow.id, runId, {
          binding: "otherEvents",
          note: "another binding's",
        }),
        delivery(workflow.id, runId, { note: "ours", subject: "job-1" }),
        delivery(workflow.id, runId, { type: failed, note: "later" }),
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- in order: acceptance order matters
        await admitRunEvent(env, event);
      }
      const asked: Asked[] = [];
      const ran = await ranAs(
        runId,
        moduleOf(
          `return [${wait("awaitJob")}, ${wait("awaitAgain")}, ${wait("awaitOther")}];`
        ),
        { engine: inboxEngine(runId, keptOfTest(), asked) }
      );
      const time: unknown = expect.stringMatching(/^\d{4}-\d\d-\d\dT/u);
      const id: unknown = expect.stringMatching(/^evt_[0-9a-f]{48}$/u);
      const event = (type: string, note: string, subject?: string) => ({
        timedOut: false,
        event: {
          id,
          type,
          source: "urn:grasp:test:sender",
          ...(subject === undefined ? {} : { subject }),
          time,
          data: { note },
        },
      });
      expect({
        ran,
        asked: asked.map(({ name, match }) => ({ name, match })),
      }).toStrictEqual({
        // Its first wait takes the oldest of either of its types; its
        // second, of its one type, finds none left but the other binding's,
        // which it never matches, and which the wait through that binding
        // takes.
        ran: {
          ended: [
            event(completed, "ours", "job-1"),
            { timedOut: true },
            event(completed, "another binding's"),
          ],
          tampered: [],
        },
        asked: [
          {
            name: "awaitJob:task",
            match: [
              { type: await eventTypeKey("jobEvents", completed) },
              { type: await eventTypeKey("jobEvents", failed) },
            ],
          },
          {
            name: "awaitAgain:task",
            match: [{ type: await eventTypeKey("jobEvents", completed) }],
          },
          {
            name: "awaitOther:task",
            match: [{ type: await eventTypeKey("otherEvents", completed) }],
          },
        ],
      });
      // The other run's event went to its inbox, never this run's.
      const journal = await runObject(runId).journal();
      expect(
        journal?.events.map(
          (each) =>
            z.object({ data: z.json() }).parse(decode(each.payload)).data
        )
      ).toStrictEqual([
        { note: "another binding's" },
        { note: "ours" },
        { note: "later" },
      ]);
    });

    it("waits until its sealed timeout from when it was first reached, the same deadline on every replay, and then answers that it timed out", async () => {
      const runId = await waitingRun(sealed);
      const kept = keptOfTest();
      const asked: Asked[] = [];
      const before = Date.now();
      const first = await ranAs(
        runId,
        moduleOf(`return ${wait("awaitJob")};`),
        {
          engine: inboxEngine(runId, kept, asked),
        }
      );
      const after = Date.now();
      const replay = await ranAs(
        runId,
        moduleOf(`return ${wait("awaitJob")};`),
        { engine: inboxEngine(runId, kept, asked) }
      );
      const reachedStep: unknown = expect.stringMatching(
        /^\$grasp:wait:[0-9a-f]{16}:reached$/u
      );
      const reached = [...kept.journal.entries()].find(([name]) =>
        name.startsWith(waitStepPrefix)
      );
      const { at } = z
        .object({ ok: z.literal(true), value: z.object({ at: z.number() }) })
        .parse(reached?.[1]).value;
      expect({
        first,
        replay,
        reached: reached?.[0],
        inRange: at >= before && at <= after,
        until: asked.map(({ until }) => until),
      }).toStrictEqual({
        first: { ended: { timedOut: true }, tampered: [] },
        replay: { ended: { timedOut: true }, tampered: [] },
        reached: reachedStep,
        inRange: true,
        // The replay asked for the same deadline, and answered what the
        // engine journaled.
        until: [at + timeoutMs, at + timeoutMs],
      });
    });

    it("takes each event once: a replay answers the event its wait took, and the next wait takes the next", async () => {
      const { workflow } = sealed;
      const runId = await waitingRun(sealed);
      for (const note of ["first", "second"]) {
        // oxlint-disable-next-line no-await-in-loop -- in order: acceptance order matters
        await admitRunEvent(env, delivery(workflow.id, runId, { note }));
      }
      const kept = keptOfTest();
      const noteOf = (id: string) => `(${wait(id)}).event?.data.note`;
      const first = await ranAs(
        runId,
        moduleOf(`return [${noteOf("awaitJob")}];`),
        {
          engine: inboxEngine(runId, kept),
        }
      );
      const resumed = await ranAs(
        runId,
        moduleOf(`return [${noteOf("awaitJob")}, ${noteOf("awaitAgain")}];`),
        { engine: inboxEngine(runId, kept) }
      );
      expect({ first, resumed }).toStrictEqual({
        first: { ended: ["first"], tampered: [] },
        resumed: { ended: ["first", "second"], tampered: [] },
      });
    });

    it("refuses an event its code makes up, and an event wait the build doesn't seal, took no event", async () => {
      const { workflow } = sealed;
      const runId = await waitingRun(sealed);
      await admitRunEvent(env, delivery(workflow.id, runId, { note: "kept" }));
      const forged =
        '{ timedOut: false, event: { id: "evt_forged", type: "grasp.job.completed", source: "urn:grasp:admin", time: "2026-01-01T00:00:00.000Z", data: { note: "forged" } } }';
      const asked: Asked[] = [];
      const run = async (body: string) =>
        await ranAs(runId, moduleOf(body), {
          engine: inboxEngine(runId, keptOfTest(), asked),
        });
      expect({
        recorded: await run(
          `return await step.do("awaitJob", { key: "task", description: "Its event" }, async () => (${forged}));`
        ),
        notAWait: await run(
          `return await step.listen("linger", { key: "task", description: "Its event" });`
        ),
        itsEnter: await run(
          `return await step.listen("awaitJob", { key: "enter", description: "Its event" });`
        ),
        noStep: await run(`return ${wait("awaitNone")};`),
      }).toStrictEqual({
        recorded: refused,
        notAWait: refused,
        itsEnter: refused,
        noStep: refused,
      });
      // None of them asked the engine for an event.
      expect(asked).toStrictEqual([]);
      // The engine itself, as code past the SDK has it: the wait runs once.
      const twice = await ranAs(
        runId,
        `export default { run: async (engine) => {
  await engine.listen("awaitJob:task");
  try { await engine.listen("awaitJob:task"); } catch (error) { return error.code; }
  return "waited twice";
} };`,
        { engine: inboxEngine(runId, keptOfTest(), asked) }
      );
      expect({ twice, asked: asked.length }).toStrictEqual({
        twice: { ended: "workflow.invalid", tampered: ["workflow.invalid"] },
        asked: 1,
      });
    });

    it("refuses a wait through a binding its start didn't freeze, a test run's checkpoint doesn't have, or whose approval was revoked, even on a replay of a wait that took its event, and no catch takes it", async () => {
      // Its own workflow: the binding it revokes is the workflow's.
      const revoking = await eventWorkflow();
      const { workflow, admin, approvals } = revoking;
      const runId = await waitingRun(revoking);
      await admitRunEvent(env, delivery(workflow.id, runId, { note: "sent" }));
      const waiting = moduleOf(`return ${wait("awaitJob")};`);
      const unfrozen = await ranAs(runId, waiting, {
        calling: (frozen) => ({
          ...frozen,
          bindings: new Map(
            [...frozen.bindings].filter(([alias]) => alias !== "jobEvents")
          ),
        }),
      });
      const unfixtured = await ranAs(runId, waiting, {
        calling: (frozen) => ({ ...frozen, candidate: new Map() }),
      });
      // A wait inside a try whose catch takes any error, as generated code
      // runs it: its code's catch may take the failure, but no catch may.
      const guarded = moduleOf(`
try {
  return (${wait("awaitGuarded")}).event?.data.note;
} catch (thrown) {
  return { caught: thrown.code };
}`);
      const kept = keptOfTest();
      const took = await ranAs(runId, guarded, {
        engine: inboxEngine(runId, kept),
      });
      await revokeWorkflowBinding(env, admin, workflow.id, approvals.jobEvents);
      const replayed = await ranAs(runId, guarded, {
        engine: inboxEngine(runId, kept),
      });
      const fresh = await ranAs(runId, guarded);
      expect({ unfrozen, unfixtured, took, replayed, fresh }).toStrictEqual({
        unfrozen: { ended: "workflow.event_denied", tampered: [] },
        unfixtured: { ended: "workflow.event_denied", tampered: [] },
        took: { ended: "sent", tampered: [] },
        // The replay after the revocation fails the run: its code's catch
        // took it, but no catch may, so the run ends with it, never on a
        // path it never took.
        replayed: {
          ended: { caught: "workflow.event_denied" },
          tampered: [],
          untaken: "workflow.event_denied",
        },
        fresh: {
          ended: { caught: "workflow.event_denied" },
          tampered: [],
          untaken: "workflow.event_denied",
        },
      });
    });

    it("holds a test run's wait to its wait limit, measured from its start", async () => {
      const runId = await waitingRun(sealed);
      await expect(
        ranAs(runId, moduleOf(`return ${wait("awaitJob")};`), {
          maxSleepMs: timeoutMs - 1,
        })
      ).resolves.toStrictEqual({
        ended: "workflow.candidate_wait_limit",
        tampered: [],
      });
    });
  }
);
