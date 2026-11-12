import {
  brainOf,
  recallBudgetMax,
  sourceIdMaxLength,
} from "@grasp-os/brain-next/contract";
import { createAuditEvent } from "@grasp-os/shared/audit";
import { env } from "cloudflare:workers";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { drainAuditOutboxes, outboxedEvent } from "../src/audit-outbox.ts";
import { noteHandOvers } from "../src/brain-hand-overs.ts";
import {
  erasePerson,
  eraseSource,
  readSourceVersionAs,
  recallAs,
  workBrain,
} from "../src/brain-next.ts";
import type { SourceRef } from "../src/brain-next.ts";
import { producersOf, relayHandOvers } from "../src/brain-sources.ts";
import { brainHandOvers, personErasures } from "../src/db/core/schema.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { shareWorkflowResource } from "../src/workflow-resources.ts";
import { sweepWorkflowStartDetails } from "../src/workflows/retention.ts";
import { allEvents } from "./audit-events.ts";
import { textOf } from "./brain-next-surfaces.ts";
import { person, startingApp } from "./workflow-calls.ts";
import {
  builder,
  definitionOf,
  ended,
  published,
  start,
} from "./workflow-resource-runs-harness.ts";

// What core hands over to the new Brain through its work queue (GRA-1727),
// through its real boundaries: a workflow run that ended, noted from its
// audit event as core's outbox drains, relayed to the Brain's work queue
// and handed over by a tick, as core's clock does. From the threat model
// on the issue, each way it can fail:
//
// - Readers wider than the producer's: a run's result recalled by anyone
//   but the person it acted for.
// - Restricted content handed over: a run started in restricted mode.
// - Duplicates: the same run handed over twice is two versions.
// - Content in the audit log.
// - What was erased, or is gone, added after all: a key erased while its
//   hand-over ran; a person erased between core's read and the add, with
//   the erasure the hand-over then owes failing once; a run past its
//   retention.
// - A hand-over lost: an intent noted again while the relay ran, an id
//   the Brain can't key, a noting that fails. (An answer without readers
//   can't come from a run: the person it acted for is a required,
//   unchangeable reference. Core checks every answer's readers all the
//   same, brain-next.ts `handOver`.)

/** A word nothing else holds. */
const word = (): string => `w${crypto.randomUUID().replaceAll("-", "")}`;

/** The queue's clock across this file: only forward, as core's clock goes. */
const clock = { at: Date.now() };

/** A tick's time, `aheadMs` past the last one's (and never before now). */
const later = (aheadMs = 0): Date => {
  clock.at = Math.max(clock.at, Date.now()) + aheadMs;
  return new Date(clock.at);
};

/** One tick of the Brain with core's producers, as core's clock ticks it. */
const tick = async (into: Env, at: Date): Promise<void> => {
  await workBrain(into, at, producersOf(into));
};

/** Hands over what changed, as core's clock does: drain, relay, a tick. */
const handOverNow = async (): Promise<void> => {
  await drainAuditOutboxes(env);
  await relayHandOvers(env);
  await tick(env, later());
};

/** The sources `personId` recalls for `question`, each with its version. */
const recalled = async (
  personId: string,
  question: string
): Promise<{ source: SourceRef; version: number }[]> => {
  const { items } = await recallAs(env, personId, {
    question,
    budget: { tokens: recallBudgetMax },
  });
  return items.map(({ source, version }) => ({ source, version }));
};

/** Whether each of `people` recalls `question`, in order. */
const whoRecalls = async (
  people: readonly { userId: string }[],
  question: string
): Promise<boolean[]> =>
  await Promise.all(
    people.map(async ({ userId }) => {
      const found = await recalled(userId, question);
      return found.length > 0;
    })
  );

/** The hand-over events recorded for source `id`, in order. */
const outcomesFor = async (id: string): Promise<string[]> => {
  const logged = await allEvents();
  return logged
    .filter(
      ({ action, target }) =>
        action.startsWith("brain.source.") && target?.id === id
    )
    .map(({ action }) => action);
};

/**
 * `real`, running `steps` in turn, each just before the next batch after
 * a statement matching `query` was prepared: one throwing fails that
 * batch.
 */
const inTurn = (
  real: D1Database,
  query: RegExp,
  steps: readonly (() => Promise<void>)[]
): D1Database => {
  const left = [...steps];
  let matched = false;
  return {
    prepare: (sql) => {
      matched ||= query.test(sql);
      return real.prepare(sql);
    },
    batch: async <T>(statements: D1PreparedStatement[]) => {
      if (matched) {
        matched = false;
        await left.shift()?.();
      }
      return await real.batch<T>(statements);
    },
    exec: async (sql) => await real.exec(sql),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
};

/** The Brain's store, as core reaches it. */
const store = () => brainOf(inJurisdiction(env, env.BRAIN_STORE));

/** Whether hand-overs wait on the queue, and whether `source`'s is parked. */
const queuedFor = async (
  source: SourceRef
): Promise<{ waiting: boolean; parked: boolean }> => {
  const { waiting, parked } = await store().workOverview();
  return {
    waiting: waiting.some(
      ({ kind, count }) => kind === "source.handover" && count > 0
    ),
    parked: parked.some(
      ({ kind, key }) =>
        kind === "source.handover" && key === `${source.producer}:${source.id}`
    ),
  };
};

/** A write to core's audit outbox: a hand-over's first is its `handover_started`. */
const auditWrite = /^insert into "audit_outbox"/iu;

/**
 * `real`, running `first` once just before the first batch after a
 * statement matching `query` was prepared: another writer that gets there
 * first, or (when `first` throws) the database failing that batch.
 */
const racing = (
  real: D1Database,
  query: RegExp,
  first: () => Promise<void>
): D1Database => {
  let matched = false;
  let raced = false;
  return {
    prepare: (sql) => {
      matched ||= query.test(sql);
      return real.prepare(sql);
    },
    batch: async <T>(statements: D1PreparedStatement[]) => {
      if (matched && !raced) {
        raced = true;
        await first();
      }
      return await real.batch<T>(statements);
    },
    exec: async (sql) => await real.exec(sql),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
};

/**
 * Notes a hand-over of run `id`, as its end's event would: built here, not
 * checked, so an id no event could name is noted too.
 */
const noteRun = async (id: string): Promise<void> => {
  await noteHandOvers(env, [
    {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      source: "core",
      actor: { type: "system" },
      action: "workflow.run.completed",
      target: { type: "workflow_run", id },
      provenance: [],
      detail: {},
    },
  ]);
};

/** A run of a new workflow `by` publishes that ended, returning `text`: its id. */
const endedRun = async (
  by: Awaited<ReturnType<typeof builder>>,
  text: string
): Promise<string> => {
  const workflow = await published(
    by,
    definitionOf([], { value: { status: text } })
  );
  const { runId } = await start(by, workflow.id);
  await ended(by, workflow.id, runId);
  return runId ?? "";
};

/** Puts the noted hand-overs on the Brain's queue, as the clock does. */
const relayNow = async (): Promise<void> => {
  await drainAuditOutboxes(env);
  await relayHandOvers(env);
};

/** `target`'s `property`, a method called on `target` itself. */
const forwarded = (target: object, property: string | symbol): unknown => {
  const value: unknown = Reflect.get(target, property);
  if (typeof value !== "function") {
    return value;
  }
  return (...args: unknown[]): unknown => {
    const result: unknown = Reflect.apply(value, target, args);
    return result;
  };
};

/**
 * The Brain's store binding `real`, whose first `eraseSource` fails, as
 * the store out of reach for a moment.
 */
const eraseFailsOnce = (real: Env["BRAIN_STORE"]): Env["BRAIN_STORE"] => {
  let failed = false;
  const stubOf = (stub: object): object =>
    new Proxy(stub, {
      get: (target, property) => {
        if (property === "eraseSource" && !failed) {
          return async () => {
            failed = true;
            await Promise.resolve();
            throw new Error("The Brain is out of reach");
          };
        }
        return forwarded(target, property);
      },
    });
  const namespaceOf = (namespace: Env["BRAIN_STORE"]): Env["BRAIN_STORE"] =>
    new Proxy(namespace, {
      get: (target, property) => {
        if (property === "jurisdiction") {
          return (jurisdiction: DurableObjectJurisdiction) =>
            namespaceOf(target.jurisdiction(jurisdiction));
        }
        if (property === "getByName") {
          return (name: string) => stubOf(target.getByName(name));
        }
        return forwarded(target, property);
      },
    });
  return namespaceOf(real);
};

/** The hand-overs noted and not yet relayed, among `ids`. */
const notedAmong = async (ids: readonly string[]): Promise<string[]> => {
  const rows = await drizzle(env.DB)
    .select({ sourceId: brainHandOvers.sourceId })
    .from(brainHandOvers)
    .where(inArray(brainHandOvers.sourceId, [...ids]));
  return rows.map(({ sourceId }) => sourceId).toSorted();
};

describe("what core hands over to the new Brain", () => {
  it("hands a run's result over once it ended, for the person it acted for alone, and nothing of a run started in restricted mode", async () => {
    const [owner, actedFor, admin, outsider] = await Promise.all([
      builder(),
      builder("user"),
      builder("admin"),
      builder("user"),
    ]);
    const secret = word();
    const workflow = await published(
      owner,
      definitionOf([], { value: { status: secret } })
    );
    await shareWorkflowResource(env, owner, workflow.id, {
      type: "person",
      id: actedFor.userId,
      role: "user",
    });
    const { runId } = await start(actedFor, workflow.id);
    const run = await ended(actedFor, workflow.id, runId);
    // A run started in restricted mode, by the same means otherwise.
    const [ada, adaAdmin] = await Promise.all([
      person("builder"),
      person("admin"),
    ]);
    const held = word();
    const heldFlow = await published(
      ada,
      definitionOf([], { value: { status: held } })
    );
    const starter = await startingApp(ada, adaAdmin, heldFlow.id, {
      restricted: true,
    });
    const heldRun = await ended(ada, heldFlow.id, await starter.start());

    await handOverNow();
    // Handed over again, as a repeat would: still its one version.
    await noteRun(runId ?? "");
    await handOverNow();

    expect({
      status: [run.status, heldRun.status],
      actedFor: await recalled(actedFor.userId, secret),
      others: await whoRecalls([owner, admin, outsider], secret),
      held: await recalled(ada.userId, held),
    }).toStrictEqual({
      status: ["completed", "completed"],
      actedFor: [{ source: { producer: "run", id: runId }, version: 1 }],
      others: [false, false, false],
      held: [],
    });
  });

  it("records each hand-over before its text leaves core and once it ended, by ids alone, and nothing for a run that isn't there", async () => {
    const runner = await builder();
    const secret = word();
    const runId = await endedRun(runner, secret);
    const missing = crypto.randomUUID();
    await noteRun(missing);

    await handOverNow();
    const logged = await allEvents();
    const events = logged.filter(({ action }) =>
      action.startsWith("brain.source.")
    );
    const about = (id: string) =>
      events
        .filter(({ target }) => target?.id === id)
        .map(({ action, actor, target, detail }) => ({
          action,
          actor,
          target,
          detail,
        }));

    expect({
      handed: about(runId),
      missing: about(missing),
      content: textOf(events).includes(secret),
    }).toStrictEqual({
      handed: [
        {
          action: "brain.source.handover_started",
          actor: { type: "system" },
          target: { type: "workflow_run", id: runId },
          detail: { producer: "run" },
        },
        {
          action: "brain.source.handed_over",
          actor: { type: "system" },
          target: { type: "workflow_run", id: runId },
          detail: { producer: "run", version: 1 },
        },
      ],
      missing: [],
      content: false,
    });
  });
});

describe("how a hand-over fails closed", () => {
  it("adds nothing of a run whose key was erased while its hand-over read it, and refuses every later hand-over of it for good, audited and never tried again", async () => {
    const runner = await builder();
    const said = word();
    const id = await endedRun(runner, said);
    const source: SourceRef = { producer: "run", id };
    await relayNow();
    // The run's erasure lands once the hand-over has read its result (its
    // first audit event), before its add.
    await tick(
      {
        ...env,
        DB: racing(env.DB, auditWrite, async () => {
          await eraseSource(env, { source, reason: "retention" });
        }),
      },
      later()
    );
    const afterErasure = await outcomesFor(id);
    // Noted again, as a repeat would; then ticks past any backoff.
    await noteRun(id);
    await relayHandOvers(env);
    await tick(env, later());
    await tick(env, later(20 * 60_000));

    expect({
      afterErasure,
      after: await outcomesFor(id),
      version: await readSourceVersionAs(env, runner.userId, {
        source,
        version: 1,
      }),
      recalled: await recalled(runner.userId, said),
      queued: await queuedFor(source),
    }).toStrictEqual({
      afterErasure: [
        "brain.source.handover_started",
        "brain.source.handover_refused",
      ],
      after: [
        "brain.source.handover_started",
        "brain.source.handover_refused",
        "brain.source.handover_started",
        "brain.source.handover_refused",
      ],
      version: null,
      recalled: [],
      queued: { waiting: false, parked: false },
    });
  });

  it("erases a person's own source whose add landed after their erasure began, also when that erasure failed once and the item is tried again", async () => {
    const runner = await builder();
    const said = word();
    const id = await endedRun(runner, said);
    const source: SourceRef = { producer: "run", id };
    await relayNow();
    // The person's erasure begins once the hand-over has read their run,
    // before its add: core's record, then the Brain's erasure. The add
    // lands after both; the erasure the hand-over then owes fails.
    await tick(
      {
        ...env,
        DB: racing(env.DB, auditWrite, async () => {
          await drizzle(env.DB).insert(personErasures).values({
            userId: runner.userId,
            name: "Erased",
            emailHash: null,
            emailKeyVersion: 1,
            requestedBy: runner.userId,
            requestedAt: new Date(),
          });
          await erasePerson(env, {
            personId: runner.userId,
            reason: "person_erased",
          });
        }),
        BRAIN_STORE: eraseFailsOnce(env.BRAIN_STORE),
      },
      later()
    );
    const landed = await readSourceVersionAs(env, runner.userId, {
      source,
      version: 1,
    });
    const afterFailure = await outcomesFor(id);
    // Past the failed attempt's backoff: the producer answers that the
    // person's erasure has begun, and the key is erased.
    await tick(env, later(2 * 60_000));

    expect({
      landed: landed?.text.includes(said),
      afterFailure,
      after: await outcomesFor(id),
      version: await readSourceVersionAs(env, runner.userId, {
        source,
        version: 1,
      }),
      queued: await queuedFor(source),
    }).toStrictEqual({
      landed: true,
      // The refusal is recorded before the key is closed; the close
      // failed, so the item was tried again, and recorded again.
      afterFailure: [
        "brain.source.handover_started",
        "brain.source.handover_refused",
      ],
      after: [
        "brain.source.handover_started",
        "brain.source.handover_refused",
        "brain.source.handover_refused",
      ],
      version: null,
      queued: { waiting: false, parked: false },
    });
  });

  it("records the refusal of an add that landed after its person's erasure, also when that record failed once, and closes the key", async () => {
    const runner = await builder();
    const said = word();
    const id = await endedRun(runner, said);
    const source: SourceRef = { producer: "run", id };
    await relayNow();
    // The person's erasure begins once the hand-over has read their run
    // (its first audit write), before its add; the add lands after it, and
    // the next audit write, the refusal's, fails once.
    await tick(
      {
        ...env,
        DB: inTurn(env.DB, auditWrite, [
          async () => {
            await drizzle(env.DB).insert(personErasures).values({
              userId: runner.userId,
              name: "Erased",
              emailHash: null,
              emailKeyVersion: 1,
              requestedBy: runner.userId,
              requestedAt: new Date(),
            });
            await erasePerson(env, {
              personId: runner.userId,
              reason: "person_erased",
            });
          },
          async () => {
            await Promise.resolve();
            throw new Error("D1 is out of reach");
          },
        ]),
      },
      later()
    );
    const afterFailure = await outcomesFor(id);
    // Past the failed attempt's backoff.
    await tick(env, later(2 * 60_000));

    expect({
      afterFailure,
      after: await outcomesFor(id),
      version: await readSourceVersionAs(env, runner.userId, {
        source,
        version: 1,
      }),
      queued: await queuedFor(source),
    }).toStrictEqual({
      afterFailure: ["brain.source.handover_started"],
      after: ["brain.source.handover_started", "brain.source.handover_refused"],
      version: null,
      queued: { waiting: false, parked: false },
    });
  });

  it("keeps a run whose result is past the Brain's bound as how it ended, saying the result was too large, never a cut part of it", async () => {
    const runner = await builder();
    // Small as given, past the bound as the word index folds it: each
    // character is 3 bytes, and 33 folded.
    const id = await endedRun(runner, "\uFDFA".repeat(31_000));
    const source: SourceRef = { producer: "run", id };
    await handOverNow();
    const kept = await readSourceVersionAs(env, runner.userId, {
      source,
      version: 1,
    });

    expect({
      outcomes: await outcomesFor(id),
      text: kept?.text,
      queued: await queuedFor(source),
    }).toStrictEqual({
      outcomes: ["brain.source.handover_started", "brain.source.handed_over"],
      text: "Workflow run completed.\n\nIts result was too large to keep.",
      queued: { waiting: false, parked: false },
    });
  });

  it("hands nothing over of a run whose details are past their retention, and is done with it", async () => {
    const runner = await builder();
    const said = word();
    const id = await endedRun(runner, said);
    // The retention's sweep, as if the run ended a retention ago.
    await sweepWorkflowStartDetails(
      env,
      new Date(Date.now() + 60_000),
      new Date()
    );
    await handOverNow();

    expect({
      outcomes: await outcomesFor(id),
      recalled: await recalled(runner.userId, said),
      queued: await queuedFor({ producer: "run", id }),
    }).toStrictEqual({
      outcomes: [],
      recalled: [],
      queued: { waiting: false, parked: false },
    });
  });

  it("keeps a hand-over noted again while the relay put it on the queue, for the next relay", async () => {
    const id = crypto.randomUUID();
    await noteRun(id);
    await relayHandOvers({
      ...env,
      DB: racing(env.DB, /^delete from "brain_hand_overs"/iu, async () => {
        await noteRun(id);
      }),
    });
    const kept = await notedAmong([id]);
    await relayHandOvers(env);

    expect({ kept, after: await notedAmong([id]) }).toStrictEqual({
      kept: [id],
      after: [],
    });
  });

  it("removes a hand-over the Brain can't key without holding up the rest", async () => {
    const runner = await builder();
    const said = word();
    const id = await endedRun(runner, said);
    const unkeyable = [`${word()}\u0007`, "x".repeat(sourceIdMaxLength + 1)];
    for (const each of unkeyable) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await noteRun(each);
    }
    await handOverNow();

    expect({
      noted: await notedAmong([...unkeyable, id]),
      recalled: await recalled(runner.userId, said),
    }).toStrictEqual({
      noted: [],
      recalled: [{ source: { producer: "run", id }, version: 1 }],
    });
  });

  it("keeps the events in their outbox while their hand-overs can't be noted, and notes them on the next drain", async () => {
    // A run's end, as core's outbox holds its event until a drain takes it.
    const id = crypto.randomUUID();
    const event = createAuditEvent(
      {
        actor: { type: "system" },
        action: "workflow.run.completed",
        target: { type: "workflow_run", id },
      },
      "core"
    );
    await outboxedEvent(drizzle(env.DB), event);
    const inOutbox = async (): Promise<boolean> => {
      const row = await env.DB.prepare(
        "SELECT 1 FROM audit_outbox WHERE id = ?"
      )
        .bind(event.id)
        .first();
      return row !== null;
    };
    await drainAuditOutboxes({
      ...env,
      DB: racing(env.DB, /^insert into "brain_hand_overs"/iu, async () => {
        await Promise.resolve();
        throw new Error("D1 is out of reach");
      }),
    }).catch(() => 0);
    const whileFailing = {
      inOutbox: await inOutbox(),
      noted: await notedAmong([id]),
    };
    await drainAuditOutboxes(env);

    expect({
      whileFailing,
      after: { inOutbox: await inOutbox(), noted: await notedAmong([id]) },
    }).toStrictEqual({
      whileFailing: { inOutbox: true, noted: [] },
      after: { inOutbox: false, noted: [id] },
    });
  });
});
