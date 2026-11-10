import { v } from "@grasp-os/runtime";
import { eventSourcePath } from "@grasp-os/shared/event-source-path";
import { eventSourceHeaders } from "@grasp-os/shared/event-sources";
import { workflowResourceIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { decode } from "@grasp-os/workerflow/codec";
import { namedError } from "@grasp-os/workerflow/errors";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { Webhook } from "standardwebhooks";
import { afterAll, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  createEventSource,
  deleteEventSource,
  rotateSourceSecret,
} from "../src/event-sources.ts";
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
import {
  keptPerSource,
  sweepEventWaits,
} from "../src/workflows/event-waits.ts";
import { RunHost } from "../src/workflows/host.ts";
import type { HostHooks, RunStep } from "../src/workflows/host.ts";
import { loadedActivation, runOf } from "../src/workflows/resource-runs.ts";
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
  SealedRunMemory,
} from "../src/workflows/sealed-run.ts";
import { allEvents } from "./audit-events.ts";
import { endLiveResourceRuns, objectSchema } from "./json-workflow-apps.ts";
import { engineOfTest } from "./run-host.ts";
import { admittedFreely, liveStatus, runObject } from "./runs.ts";
import { moduleOf as harnessModuleOf } from "./sealed-run-harness.ts";
import { routed, unique } from "./sign-in.ts";

// Waits on an event source's events by a match (event-waits.ts), from
// their threat model. A run waits for `payment.paid` whose data's
// `/invoice` is its own invoice; events come in signed, at the source's
// URL, as any sender's do. The ways it can fail, each closed:
//
// - one run's event reaching another: only an event whose data has the
//   run's own value is handed to it, and only from the source its
//   binding's approval names;
// - a kept event taken by the wrong run, or by two: one that came before
//   the wait is taken by the first wait of its match, once, and a replay
//   of that wait takes nothing more;
// - a delivery retried, or core killed between taking a kept event and
//   handing it over: the same event once in the run's inbox;
// - a kept event its run can't take (its data isn't the contract's): let
//   go for another, the refusal audited;
// - an approval revoked or the source deleted while events are kept, and
//   kept events past their day: nothing takes them, and they go;
// - a wait that could take anyone's event: publication refuses a wait on a
//   source's type without a match, and approval names exactly one source.
//
// Each run is a real start of a real published workflow, waiting out its
// hour; its wait runs in a real isolate, a module of the test's own as
// generated code runs it, on the run host, with an engine whose waits
// take from the run's real inbox the oldest event matching their type
// and attributes, and time out at once when there is none.

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

const paid = "payment.paid";

/** A payment's data, as the contract takes it. */
const paymentData = JSON.stringify(
  v.object({ invoice: v.string(), amount: v.number() }).descriptor
);

/** A wait for a payment of the run's own invoice, five minutes at most. */
const awaitPaid = {
  id: "awaitPaid",
  type: "waitForEvent",
  events: "payments",
  eventType: paid,
  match: { field: "/invoice", equals: { $expr: "args.invoice" } },
  timeout: "5 minutes",
};

/** A source of an admin's, with its token and secret. */
const sourceOf = async (admin: Identity) => {
  const { source, secret } = await createEventSource(env, admin, {
    name: `Payments ${unique()}`,
  });
  return { id: source.id, token: source.delivery?.token ?? "", secret };
};

/**
 * A workflow on input `{ invoice }` whose run waits out its hour, then
 * waits for a payment of its invoice through `payments`, a contract that
 * takes `payment.paid` from a webhook source, approved for a source of
 * its own.
 */
const paymentWorkflow = async (on?: {
  admin: Identity;
  source: Awaited<ReturnType<typeof sourceOf>>;
}) => {
  const admin = on?.admin ?? (await person("admin"));
  const contract = `payments-${unique()}`;
  await publishCatalogContract(env, admin, {
    key: contract,
    kind: "event",
    events: {
      [paid]: { data: paymentData, browser: false, ingress: "webhook" },
    },
  });
  const workflow = await createWorkflowResource(env, admin, `pay-${unique()}`);
  await publishWorkflowVersion(env, admin, workflow.id, {
    definition: JSON.stringify({
      $schema: workflowSchemaUrl,
      args: objectSchema({ invoice: { kind: "string" } }),
      permissions: { events: { payments: { contract } } },
      steps: [{ id: "linger", type: "wait", for: "1 hour" }, awaitPaid],
    }),
    basedOn: null,
  });
  const source = on?.source ?? (await sourceOf(admin));
  const approval = await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "payments",
    target: { kind: "event", source: source.id },
    reviewed: { version: 1 },
  });
  return { admin, contract, workflow, source, approval: approval.id };
};

type PaymentWorkflow = Awaited<ReturnType<typeof paymentWorkflow>>;

/** A run of the workflow for `invoice`, once it waits out its hour. */
const waitingRun = async (
  { admin, workflow }: PaymentWorkflow,
  invoice: string
): Promise<string> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: admin },
    workflow.id,
    { version: 1, args: { invoice }, key: unique() }
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

/**
 * Sends the event `type` with `data` to `source`'s URL, signed as any
 * sender of Standard Webhooks signs, under `webhook-id` `id`.
 */
const send = async (
  source: { token: string; secret: string },
  data: unknown,
  {
    id = `msg_${unique()}`,
    type = paid,
    coreEnv = env,
  }: { id?: string; type?: string; coreEnv?: Env } = {}
): Promise<number> => {
  const body = JSON.stringify({ type, data });
  const at = new Date();
  const response = await routed(
    `${eventSourcePath}/${source.token}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [eventSourceHeaders.id]: id,
        [eventSourceHeaders.timestamp]: String(Math.floor(at.getTime() / 1000)),
        [eventSourceHeaders.signature]: new Webhook(source.secret).sign(
          id,
          at,
          body
        ),
      },
      body,
    },
    coreEnv
  );
  return response.status;
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
 * The run's wait, as generated code runs it: its enter step records the
 * value it matches (`key`, as code: its input's invoice unless given),
 * then it waits; the run answers the invoice of the event it took, or
 * that none came.
 */
const waiting = (key = "args.invoice"): string =>
  harnessModuleOf(`
  await step.do("awaitPaid", { key: "enter", description: "Its match" }, async () => ({ key: ${key} }));
  const waited = await step.listen("awaitPaid", { key: "task", description: "Its payment" });
  return waited.timedOut ? "none" : waited.event.data.invoice;`);

/** The engine's own record of a run, as a later activation finds it. */
interface Kept {
  readonly journal: Map<string, { ok: true; value: unknown } | { ok: false }>;
  readonly taken: Set<number>;
}

const keptOfTest = (): Kept => ({ journal: new Map(), taken: new Set() });

/** An engine of the test's own, as `engineOfTest`'s. */
type Engine = Pick<ReturnType<typeof engineOfTest>, "step" | "leaseOf">;

const attributesSchema = z.record(z.string(), z.string());

/**
 * An engine whose waits run `meanwhile` (what happens while the run
 * waits), then take from run `runId`'s real inbox the oldest event none
 * took before that matches one of the wait's entries, its engine type and
 * every attribute it names, and time out at once when there is none; it
 * journals each step in `kept`, so a later activation replays it.
 */
const inboxEngine = (
  runId: string,
  kept: Kept = keptOfTest(),
  meanwhile: () => Promise<unknown> = async () => {
    await Promise.resolve();
  }
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
    const value = await run();
    kept.journal.set(name, { ok: true, value });
    return value;
  };
  const taking: RunStep["waitForMatch"] = async (_name, { match }) => {
    await meanwhile();
    const journal = await runObject(runId).journal();
    const event = journal?.events.find(
      (each) =>
        !kept.taken.has(each.seq) &&
        match.some(
          (entry) =>
            entry.type === each.type &&
            Object.entries(entry.attributes ?? {}).every(
              ([attribute, value]) =>
                attributesSchema.parse(JSON.parse(each.attributes ?? "{}"))[
                  attribute
                ] === value
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
      return lease === undefined ? undefined : { ...lease, generation: 1000 };
    },
    step: {
      ...step,
      do: async (name, config, fn) =>
        await replayed(name, async () => await step.do(name, config, fn)),
      waitForMatch: async (name, options) =>
        z
          .object({ payload: z.unknown(), timestamp: z.date() })
          .parse(await replayed(name, async () => await taking(name, options))),
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
 * Runs `source` as run `runId` of its sealed build on the run host, on
 * `engine`, with core's `coreEnv`: what it ended with (its value, or its
 * error's code), and what the host refused as tampering.
 */
const ranAs = async (
  runId: string,
  source: string,
  engine: Engine = inboxEngine(runId),
  coreEnv: Env = env
) => {
  const run = await sealedRunOf(runId);
  const tampered: string[] = [];
  const host = new RunHost(
    coreEnv,
    engine.step,
    (controls) => sealedRun(coreEnv, run, memoryOfTest())(controls),
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
  const code = loadSealedIsolate(coreEnv, {
    owner: `test:${runId}:${unique()}`,
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
    await code.run(host, await sealedRunStart(coreEnv, run))
  );
  return {
    ended: settled.ok ? settled.value : settled.error.code,
    tampered,
  };
};

/** The invoices of the events in run `runId`'s inbox, oldest first. */
const inboxOf = async (runId: string): Promise<unknown[]> => {
  const journal = await runObject(runId).journal();
  return (journal?.events ?? []).map(
    (each) =>
      z
        .object({ data: z.object({ invoice: z.string() }) })
        .parse(decode(each.payload)).data.invoice
  );
};

/**
 * Source `source`'s kept events, oldest first: each one's data, and the
 * runs that took it, in order.
 */
const keptOf = async (source: string) => {
  const rows = await env.DB.prepare(
    `SELECT event.data, (SELECT json_group_array(run_id) FROM (SELECT run_id FROM kept_event_takes WHERE event_id = event.id ORDER BY taken_at, run_id)) AS takers
     FROM kept_events AS event WHERE source_id = ? ORDER BY received_at, id`
  )
    .bind(source)
    .all<{ data: string; takers: string }>();
  return rows.results.map(({ data, takers }) => ({
    data: z.json().parse(JSON.parse(data)),
    taken: z.array(z.string()).parse(JSON.parse(takers)),
  }));
};

/** Which runs took each of source `source`'s kept events, oldest first. */
const takenOf = async (source: string): Promise<string[][]> => {
  const kept = await keptOf(source);
  return kept.map(({ taken }) => taken);
};

/** How many events source `source` keeps, taken or not. */
const keptCount = async (source: string): Promise<number> => {
  const kept = await keptOf(source);
  return kept.length;
};

/** The `field` of each audit event of `action` on `target`. */
const auditedOf = async (
  action: string,
  target: string,
  field: string
): Promise<unknown[]> => {
  const events = await allEvents();
  return events
    .filter((event) => event.action === action && event.target?.id === target)
    .map(({ detail }) => detail[field]);
};

/**
 * Core's env whose first batch that keeps an event (`kept_events`) says
 * so (`atKeep`), then waits for `gate` before it runs: a delivery paused
 * just there.
 */
const pausedAtKeep = (gate: Promise<unknown>, atKeep: () => void): Env => {
  const real = env.DB;
  const queries = new WeakMap<D1PreparedStatement, string>();
  let paused = false;
  const remembered = (
    statement: D1PreparedStatement,
    query: string
  ): D1PreparedStatement => {
    queries.set(statement, query);
    return statement;
  };
  const DB: D1Database = {
    prepare: (query) => {
      const statement = real.prepare(query);
      const bind = statement.bind.bind(statement);
      return remembered(
        Object.assign(statement, {
          bind: (...values: unknown[]) => remembered(bind(...values), query),
        }),
        query
      );
    },
    batch: async <T>(statements: D1PreparedStatement[]) => {
      if (
        !paused &&
        statements.some((each) =>
          (queries.get(each) ?? "").startsWith('insert into "kept_events"')
        )
      ) {
        paused = true;
        atKeep();
        await gate;
      }
      return await real.batch<T>(statements);
    },
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
  return { ...env, DB };
};

/**
 * Core's env with `first` run once, just before the first statement whose
 * query `at` matches runs: someone acting between what core read and that
 * statement.
 */
const racedAt = (at: RegExp, first: () => Promise<unknown>): Env => {
  const real = env.DB;
  let raced = false;
  const DB: D1Database = {
    prepare: (query) => {
      const statement = real.prepare(query);
      if (raced || !at.test(query)) {
        return statement;
      }
      raced = true;
      const racing = (prepared: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(prepared, {
          get: (target, property, receiver) => {
            if (property === "bind") {
              return (...values: unknown[]) => racing(target.bind(...values));
            }
            if (
              property === "all" ||
              property === "first" ||
              property === "raw" ||
              property === "run"
            ) {
              return async (...args: unknown[]) => {
                await first();
                const run: unknown = Reflect.get(target, property, target);
                if (typeof run !== "function") {
                  throw new TypeError(`No ${property} on a statement`);
                }
                const result: unknown = await Reflect.apply(run, target, args);
                return result;
              };
            }
            const value: unknown = Reflect.get(target, property, receiver);
            return value;
          },
        });
      return racing(statement);
    },
    batch: async <T>(statements: D1PreparedStatement[]) =>
      await real.batch<T>(statements),
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
  return { ...env, DB };
};

/** Inserts `count` kept events of `source`, expired unless `fresh`, straight in the database. */
const keptRows = async (
  source: string,
  count: number,
  { fresh = false } = {}
): Promise<void> => {
  const at = fresh ? Date.now() + 3_600_000 : Date.now() - 1;
  const statements = Array.from({ length: count }, (_, index) =>
    env.DB.prepare(
      "INSERT INTO kept_events (id, source_id, event_type, data, received_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(`old-${source}-${index}`, source, paid, "{}", Date.now(), at)
  );
  for (let start = 0; start < statements.length; start += 500) {
    // oxlint-disable-next-line no-await-in-loop -- one batch after another
    await env.DB.batch(statements.slice(start, start + 500));
  }
};

/**
 * Core's env with its `nth` statement matching `at` failing, as core
 * killed just there.
 */
const failingAt = (at: RegExp, nth = 1): Env => {
  const real = env.DB;
  let seen = 0;
  const DB: D1Database = {
    prepare: (query) => {
      const statement = real.prepare(query);
      if (!at.test(query)) {
        return statement;
      }
      seen += 1;
      if (seen !== nth) {
        return statement;
      }
      return new Proxy(statement, {
        get: (target, property, receiver) => {
          if (property === "bind") {
            return () => {
              throw new Error("The isolate was killed");
            };
          }
          const value: unknown = Reflect.get(target, property, receiver);
          return value;
        },
      });
    },
    batch: async <T>(statements: D1PreparedStatement[]) =>
      await real.batch<T>(statements),
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
  return { ...env, DB };
};

const invoice = (id: string, amount: unknown = 120) => ({
  invoice: id,
  amount,
});

describe(
  "a wait on a webhook source's events by a match",
  { timeout: 120_000 },
  () => {
    afterAll(endLiveResourceRuns);

    it("takes the event of its own match that came before it waited, kept for it, and leaves another's untaken", async () => {
      const paying = await paymentWorkflow();
      const runId = await waitingRun(paying, "INV-1");
      const early = [
        await send(paying.source, invoice("INV-2")),
        await send(paying.source, invoice("INV-1")),
      ];
      const ran = await ranAs(runId, waiting());

      expect({
        early,
        ran,
        inbox: await inboxOf(runId),
        kept: await keptOf(paying.source.id),
      }).toStrictEqual({
        early: [202, 202],
        ran: { ended: "INV-1", tampered: [] },
        inbox: ["INV-1"],
        // Kept for its day, for any other run that waits for it.
        kept: [
          { data: invoice("INV-2"), taken: [] },
          { data: invoice("INV-1"), taken: [runId] },
        ],
      });
    });

    it("takes an event of its match that comes while it waits, once, kept for others, and ends its wait", async () => {
      const paying = await paymentWorkflow();
      const runId = await waitingRun(paying, "INV-1");
      const statuses: number[] = [];
      const ran = await ranAs(
        runId,
        waiting(),
        inboxEngine(runId, keptOfTest(), async () => {
          statuses.push(await send(paying.source, invoice("INV-1")));
        })
      );
      const waits = await env.DB.prepare(
        "SELECT COUNT(*) AS waits FROM event_waits WHERE run_id = ?"
      )
        .bind(runId)
        .first<{ waits: number }>();

      expect({
        statuses,
        ran,
        inbox: await inboxOf(runId),
        kept: await keptOf(paying.source.id),
        waits: waits?.waits,
      }).toStrictEqual({
        statuses: [202],
        ran: { ended: "INV-1", tampered: [] },
        inbox: ["INV-1"],
        kept: [{ data: invoice("INV-1"), taken: [runId] }],
        waits: 0,
      });
    });

    it("hands a kept event to each run that waits on its match, each once, another workflow's too, and a replay takes nothing more", async () => {
      const paying = await paymentWorkflow();
      // Another workflow, on the same source, waiting on the same invoice.
      const also = await paymentWorkflow(paying);
      const first = await waitingRun(paying, "INV-7");
      const second = await waitingRun(paying, "INV-7");
      const other = await waitingRun(also, "INV-7");
      await send(paying.source, invoice("INV-7"));
      const kept = keptOfTest();
      const ranFirst = await ranAs(first, waiting(), inboxEngine(first, kept));
      const ranSecond = await ranAs(second, waiting());
      const ranOther = await ranAs(other, waiting());
      // Another event of the match, kept after the first run took its own.
      await send(paying.source, invoice("INV-7", 99));
      const replayed = await ranAs(first, waiting(), inboxEngine(first, kept));

      expect({
        ran: [ranFirst, ranSecond, ranOther, replayed].map(
          ({ ended }) => ended
        ),
        inboxes: [
          await inboxOf(first),
          await inboxOf(second),
          await inboxOf(other),
        ],
        kept: await takenOf(paying.source.id),
      }).toStrictEqual({
        ran: ["INV-7", "INV-7", "INV-7", "INV-7"],
        inboxes: [["INV-7"], ["INV-7"], ["INV-7"]],
        // The later one stays untaken: the replay took nothing more.
        kept: [[first, second, other], []],
      });
    });

    it("hands a run an event that came as its wait was being reached, whichever went first", async () => {
      const paying = await paymentWorkflow();
      const runId = await waitingRun(paying, "INV-1");
      // The delivery pauses just as it keeps the event, until the wait has
      // registered and looked for kept events, found none, and gone on;
      // the wait is reached only once the delivery got that far.
      const entered = Promise.withResolvers<boolean>();
      const keeping = Promise.withResolvers<boolean>();
      const pausing = pausedAtKeep(entered.promise, () => {
        keeping.resolve(true);
      });
      const engine = inboxEngine(runId);
      let sending: Promise<number> | undefined;
      const racing: Engine = {
        ...engine,
        step: {
          ...engine.step,
          do: async (name, config, fn) => {
            if (!name.endsWith(":entered")) {
              return await engine.step.do(name, config, fn);
            }
            sending = send(paying.source, invoice("INV-1"), {
              coreEnv: pausing,
            });
            await keeping.promise;
            const done = await engine.step.do(name, config, fn);
            entered.resolve(true);
            await sending;
            return done;
          },
        },
      };
      const ran = await ranAs(runId, waiting(), racing);

      expect({
        sent: await sending,
        ran,
        inbox: await inboxOf(runId),
      }).toStrictEqual({
        sent: 202,
        ran: { ended: "INV-1", tampered: [] },
        inbox: ["INV-1"],
      });
    });

    it("takes nothing of another source, another type, or another invoice", async () => {
      const paying = await paymentWorkflow();
      const runId = await waitingRun(paying, "INV-1");
      const other = await sourceOf(paying.admin);
      await send(other, invoice("INV-1"));
      await send(paying.source, invoice("INV-1"), { type: "payment.failed" });
      await send(paying.source, invoice("INV-10"));
      await send(paying.source, { invoice: { id: "INV-1" }, amount: 1 });
      const ran = await ranAs(runId, waiting());

      expect({ ran, inbox: await inboxOf(runId) }).toStrictEqual({
        ran: { ended: "none", tampered: [] },
        inbox: [],
      });
    });

    it("takes a delivery and its sender's retry as one event", async () => {
      const paying = await paymentWorkflow();
      const runId = await waitingRun(paying, "INV-1");
      await send(paying.source, invoice("INV-1"), { id: "msg_same" });
      await send(paying.source, invoice("INV-1"), { id: "msg_same" });
      const ran = await ranAs(runId, waiting());
      const retried = await send(paying.source, invoice("INV-1"), {
        id: "msg_same",
      });

      expect({
        ran,
        retried,
        inbox: await inboxOf(runId),
        kept: await keptCount(paying.source.id),
      }).toStrictEqual({
        ran: { ended: "INV-1", tampered: [] },
        retried: 202,
        inbox: ["INV-1"],
        kept: 1,
      });
    });

    it("lets go of a kept event its run's contract refuses, audited, for a run that can take it", async () => {
      const paying = await paymentWorkflow();
      const runId = await waitingRun(paying, "INV-1");
      await send(paying.source, invoice("INV-1", "lots"));
      const ran = await ranAs(runId, waiting());
      const audited = await auditedOf(
        "workflow.webhook.wait_refused",
        runId,
        "reason"
      );

      expect({
        ran,
        inbox: await inboxOf(runId),
        kept: await keptOf(paying.source.id),
        audited,
      }).toStrictEqual({
        ran: { ended: "none", tampered: [] },
        inbox: [],
        kept: [{ data: invoice("INV-1", "lots"), taken: [] }],
        audited: ["event_invalid"],
      });
    });

    it("goes on past a kept event its run refuses to a newer one of its match", async () => {
      const paying = await paymentWorkflow();
      const runId = await waitingRun(paying, "INV-1");
      await send(paying.source, invoice("INV-1", "lots"));
      await send(paying.source, invoice("INV-1", 5));
      const ran = await ranAs(runId, waiting());

      expect({ ran, kept: await takenOf(paying.source.id) }).toStrictEqual({
        ran: { ended: "INV-1", tampered: [] },
        // The refused one let go; the newer one taken.
        kept: [[], [runId]],
      });
    });

    it("refuses a retry carrying another event, matching nothing by it", async () => {
      const paying = await paymentWorkflow();
      const runId = await waitingRun(paying, "INV-B");
      const first = await send(paying.source, invoice("INV-A"), {
        id: "msg_twice",
      });
      const other = await send(paying.source, invoice("INV-B"), {
        id: "msg_twice",
      });
      const ran = await ranAs(runId, waiting());

      expect({
        statuses: [first, other],
        ran,
        kept: await keptOf(paying.source.id),
      }).toStrictEqual({
        statuses: [202, 409],
        ran: { ended: "none", tampered: [] },
        kept: [{ data: invoice("INV-A"), taken: [] }],
      });
    });

    it("hands a waiting run nothing of a delivery whose secret was rotated as it was handed", async () => {
      const paying = await paymentWorkflow();
      const runId = await waitingRun(paying, "INV-1");
      // Rotated after the delivery was checked, as it looks for waits.
      const rotating = racedAt(/from "event_waits"/u, async () => {
        await rotateSourceSecret(env, paying.admin, paying.source.id);
      });
      const statuses: number[] = [];
      const ran = await ranAs(
        runId,
        waiting(),
        inboxEngine(runId, keptOfTest(), async () => {
          statuses.push(
            await send(paying.source, invoice("INV-1"), { coreEnv: rotating })
          );
        })
      );

      expect({
        statuses,
        ran,
        inbox: await inboxOf(runId),
      }).toStrictEqual({
        statuses: [401],
        ran: { ended: "none", tampered: [] },
        inbox: [],
      });
    });

    it("sweeps every kept event past its day in one run, in batches, and counts those not yet swept toward the cap", async () => {
      const paying = await paymentWorkflow();
      const sweeping = await sourceOf(paying.admin);
      await keptRows(sweeping.id, 1200);
      await sweepEventWaits(env);
      const leftAfterSweep = await keptCount(sweeping.id);
      // A source holding as many as it may, expired but not yet swept,
      // keeps nothing more.
      await keptRows(paying.source.id, keptPerSource);
      const status = await send(paying.source, invoice("INV-1"));
      const full = await keptCount(paying.source.id);

      expect({ leftAfterSweep, status, full }).toStrictEqual({
        leftAfterSweep: 0,
        status: 202,
        full: keptPerSource,
      });
    });

    it("hands the kept event it took once, when core was killed before it said so, and takes no other", async () => {
      const paying = await paymentWorkflow();
      const runId = await waitingRun(paying, "INV-1");
      await send(paying.source, invoice("INV-1"));
      await send(paying.source, invoice("INV-1", 2));
      // Killed after the wait took the kept event, before it handed it
      // over: its wait's step never journaled.
      const killed = await ranAs(
        runId,
        waiting(),
        inboxEngine(runId),
        failingAt(/from "kept_event_takes" inner join/u)
      ).then(
        (outcome) => outcome,
        () => ({ ended: "killed", tampered: [] })
      );
      // The engine tries its step again, on a fresh core.
      const again = await ranAs(runId, waiting());

      expect({
        killed: killed.ended === "INV-1" ? "took it" : "stopped",
        again,
        inbox: await inboxOf(runId),
        kept: await takenOf(paying.source.id),
      }).toStrictEqual({
        killed: "stopped",
        again: { ended: "INV-1", tampered: [] },
        inbox: ["INV-1"],
        kept: [[runId], []],
      });
    });

    it("takes nothing kept once its approval is revoked, and keeps nothing of a source once deleted", async () => {
      const paying = await paymentWorkflow();
      const runId = await waitingRun(paying, "INV-1");
      await send(paying.source, invoice("INV-1"));
      await revokeWorkflowBinding(
        env,
        paying.admin,
        paying.workflow.id,
        paying.approval
      );
      const revoked = await ranAs(runId, waiting());
      const whileRevoked = await keptOf(paying.source.id);
      await deleteEventSource(env, paying.admin, paying.source.id);
      await sweepEventWaits(env);

      expect({
        revoked,
        whileRevoked: whileRevoked.map(({ taken }) => taken.length),
        afterDeleting: await keptOf(paying.source.id),
      }).toStrictEqual({
        revoked: { ended: "workflow.event_denied", tampered: [] },
        whileRevoked: [0],
        afterDeleting: [],
      });
    });

    it("lets a kept event expire after its day, taken by nothing, audited by its source", async () => {
      const paying = await paymentWorkflow();
      const runId = await waitingRun(paying, "INV-1");
      await send(paying.source, invoice("INV-1"));
      // A day on.
      await env.DB.prepare(
        "UPDATE kept_events SET expires_at = ? WHERE source_id = ?"
      )
        .bind(Date.now() - 1, paying.source.id)
        .run();
      const ran = await ranAs(runId, waiting());
      await sweepEventWaits(env);
      const audited = await auditedOf(
        "workflow.webhook.kept_expired",
        paying.source.id,
        "events"
      );

      expect({
        ran,
        kept: await keptOf(paying.source.id),
        audited,
      }).toStrictEqual({
        ran: { ended: "none", tampered: [] },
        kept: [],
        audited: [1],
      });
    });

    it("fails a wait whose match is no text, number or boolean, and refuses one its build didn't seal", async () => {
      const paying = await paymentWorkflow();
      const runId = await waitingRun(paying, "INV-1");
      const notScalar = await ranAs(
        runId,
        waiting("{ invoice: input.invoice }")
      );
      const otherRun = await waitingRun(paying, "INV-2");
      // The enter step records a value the sealed expression's slot takes,
      // but no `{ key }`: tampering.
      const unsealed = await ranAs(
        otherRun,
        waiting().replace(
          "({ key: args.invoice })",
          "({ value: args.invoice })"
        )
      );

      expect({ notScalar, unsealed }).toStrictEqual({
        notScalar: { ended: "workflow.call_invalid", tampered: [] },
        unsealed: { ended: "workflow.invalid", tampered: ["workflow.invalid"] },
      });
    });
  }
);

describe("publishing and approving a wait on a webhook source's events", () => {
  it("refuses a wait on a source's type without a match, a match on a type no source sends, and an approval naming no source or one its contract doesn't take", async () => {
    const admin = await person("admin");
    const contract = `payments-${unique()}`;
    await publishCatalogContract(env, admin, {
      key: contract,
      kind: "event",
      events: {
        [paid]: { data: paymentData, browser: false, ingress: "webhook" },
        "payment.noted": { data: paymentData, browser: false },
      },
    });
    const workflow = await createWorkflowResource(
      env,
      admin,
      `pay-${unique()}`
    );
    /** Publishing `awaitPaid` changed by `change`: "published", or its problems' codes. */
    const publishing = async (change: Record<string, unknown>) => {
      try {
        await publishWorkflowVersion(env, admin, workflow.id, {
          definition: JSON.stringify({
            $schema: workflowSchemaUrl,
            args: objectSchema({ invoice: { kind: "string" } }),
            permissions: { events: { payments: { contract } } },
            steps: [{ ...awaitPaid, ...change }],
          }),
          basedOn: null,
        });
        return "published";
      } catch (error) {
        return z
          .object({
            details: z.object({
              problems: z.array(z.object({ code: z.string() })),
            }),
          })
          .parse(error)
          .details.problems.map(({ code }) => code);
      }
    };
    const unmatched = await publishing({ match: undefined });
    const unsourced = await publishing({ eventType: "payment.noted" });
    const published = await publishing({});
    const source = await sourceOf(admin);
    const approving = async (target: unknown) => {
      try {
        await approveWorkflowBinding(env, admin, workflow.id, {
          alias: "payments",
          target,
          reviewed: { version: 1 },
        });
        return "approved";
      } catch (error) {
        return z.object({ code: z.string() }).parse(error).code;
      }
    };
    const noSource = await approving({ kind: "event" });
    const unknownSource = await approving({ kind: "event", source: "nope" });
    const approved = await approving({ kind: "event", source: source.id });

    expect({
      unmatched,
      unsourced,
      published,
      noSource,
      unknownSource,
      approved,
    }).toStrictEqual({
      unmatched: ["event.match_required"],
      unsourced: ["event.match_unsourced"],
      published: "published",
      noSource: "workflow.binding_invalid",
      unknownSource: "workflow.binding_invalid",
      approved: "approved",
    });
  });
});
