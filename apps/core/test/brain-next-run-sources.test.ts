import {
  personalBrainOf,
  recallBudgetMax,
} from "@grasp-os/brain-next/contract";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { appIdSchema, workflowResourceIdSchema } from "@grasp-os/shared/ids";
import type { Authority } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";

import { drainAuditOutboxes } from "../src/audit-drains.ts";
import { organizationId } from "../src/auth/auth.ts";
import { memberOf } from "../src/auth/identity.ts";
import { runRemovalsMax, runSource } from "../src/brain-next-origins.ts";
import {
  listVersionsAs,
  readSourceVersionAs,
  recallAs,
  workBrain,
} from "../src/brain-next.ts";
import type { Producers, SourceRef } from "../src/brain-next.ts";
import { removeLostRunSources } from "../src/brain-run-sources.ts";
import { producersOf, relayHandOvers } from "../src/brain-sources.ts";
import {
  auditOutboxRejected,
  teamMembers,
  teams,
} from "../src/db/core/schema.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import {
  shareWorkflowResource,
  unshareWorkflowResource,
} from "../src/workflow-members.ts";
import { deleteWorkflowResource } from "../src/workflow-resources.ts";
import { appWorkflowStarts } from "../src/workflow-start-intents.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { standInBinding, standInLive } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { outcome, unique } from "./sign-in.ts";
import { granted, person } from "./workflow-calls.ts";
import {
  builder,
  definitionOf,
  ended,
  published,
  start,
} from "./workflow-resource-runs-harness.ts";

// A person's run results leave use in the Brain once they lose the
// workflow (GRA-1829 option 2, built in GRA-1816; the threat model is on
// GRA-1816), through core's real boundaries: a run that ended, handed over
// as core's clock does, then the role lost through core's own writes, and
// the clock's task. From the threat model:
//
// - Someone who lost the workflow keeps recalling what their runs
//   returned: from the task on, their recall, version reads and history
//   answer as for a run never handed over, while the run page refuses them.
// - Someone who keeps the role loses nothing.
// - A run that ends after the loss is handed over after all; one whose
//   hand-over read the role before the loss lands after the removal.
// - Regaining the role brings old results back.
// - A cut-off at any step leaves the removal undone or unaudited, or
//   audits it twice.

/** A word nothing else holds. */
const word = (): string => `w${crypto.randomUUID().replaceAll("-", "")}`;

/** The clock's time for the Brain's ticks here: only forward. */
const clock = { at: Date.now() };

/** A tick's time, never before the last. */
const later = (): Date => {
  clock.at = Math.max(clock.at + 1, Date.now());
  return new Date(clock.at);
};

/** Hands over what changed, as core's clock does: drain, relay, a tick. */
const handOverNow = async (
  producers: Producers = producersOf(env)
): Promise<void> => {
  await drainAuditOutboxes(env);
  await relayHandOvers(env);
  await workBrain(env, later(), producers);
};

type Person = Awaited<ReturnType<typeof builder>>;

/** A workflow `owner` publishes, returning `text`, shared with `users` as users. */
const sharedWorkflow = async (
  owner: Person,
  text: string,
  ...users: Person[]
): Promise<string> => {
  const workflow = await published(
    owner,
    definitionOf([], { value: { status: text } })
  );
  for (const user of users) {
    // oxlint-disable-next-line no-await-in-loop -- one share at a time
    await shareWorkflowResource(env, owner, workflow.id, {
      type: "person",
      id: user.userId,
      role: "user",
    });
  }
  return workflow.id;
};

/** A run of workflow `id` that `by` started and that ended: its id. */
const endedRun = async (by: Person, id: string): Promise<string> => {
  const { runId } = await start(by, id);
  await ended(by, id, runId);
  return runId ?? "";
};

/** Stops sharing workflow `id` with `user`, as its owner. */
const unshared = async (owner: Person, id: string, user: Person) => {
  await unshareWorkflowResource(env, owner, id, {
    type: "person",
    id: user.userId,
  });
};

/** Whether `personId` recalls run `runId`'s source for `question`. */
const recalls = async (
  personId: string,
  question: string,
  runId: string
): Promise<boolean> => {
  const { items } = await recallAs(env, personId, {
    question,
    budget: { tokens: recallBudgetMax },
    personal: true,
  });
  return items.some(
    ({ source }) => source.producer === "run" && source.id === runId
  );
};

/** What a read answered: its value, or its error's message. */
const answerOf = async (read: () => Promise<unknown>): Promise<string> => {
  try {
    return JSON.stringify(await read());
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/**
 * What `personId` gets of run `runId`'s source's version and history,
 * each "as never handed over" when it answers as a run nobody handed over
 * does, else what it answered.
 */
const readsOf = async (personId: string, runId: string) => {
  const never = runSource(crypto.randomUUID());
  const asNever = async (
    read: (source: SourceRef) => Promise<unknown>
  ): Promise<string> => {
    const got = await answerOf(async () => await read(runSource(runId)));
    const missing = await answerOf(async () => await read(never));
    return got === missing ? "as never handed over" : got;
  };
  return {
    version: await asNever(
      async (source) =>
        await readSourceVersionAs(env, personId, { source, version: 1 })
    ),
    history: await asNever(
      async (source) => await listVersionsAs(env, personId, { source })
    ),
  };
};

const neverHandedOver = {
  version: "as never handed over",
  history: "as never handed over",
};

/** The removals recorded for workflow `id`: each one's detail and time. */
const removalsOf = async (id: string) => {
  const logged = await allEvents();
  return logged
    .filter(
      ({ action, target }) =>
        action === "brain.run_sources.removed" && target?.id === id
    )
    .map(({ detail, at, actor }) => ({ detail, at, actor }));
};

/** The details of the removals recorded for workflow `id`. */
const removedOf = async (id: string) => {
  const removals = await removalsOf(id);
  return removals.map(({ detail }) => detail);
};

/** How many removals were recorded for workflow `id`. */
const removalCountOf = async (id: string): Promise<number> => {
  const removals = await removalsOf(id);
  return removals.length;
};

/** When `personId`'s run sources of workflow `id` were last revoked, as stored. */
const revokedAtOf = async (personId: string, id: string) => {
  const row = await env.DB.prepare(
    "SELECT revoked_at AS revokedAt FROM brain_run_sources WHERE person_id = ? AND workflow_id = ?"
  )
    .bind(personId, id)
    .first<{ revokedAt: number }>();
  return row === null ? null : new Date(row.revokedAt).toISOString();
};

/** How the hand-over of run `id` ended in the log, with its reason. */
const endingsFor = async (id: string): Promise<string[]> => {
  const logged: AuditEvent[] = await allEvents();
  return logged
    .filter(
      ({ action, target }) =>
        action.startsWith("brain.source.") &&
        action !== "brain.source.handover_started" &&
        target?.id === id
    )
    .map(({ action, detail }) =>
      typeof detail.reason === "string" ? `${action}:${detail.reason}` : action
    );
};

/** How many events the drain set aside as rejected (a conflict, say). */
const rejectedCount = async (): Promise<number> => {
  const rows = await drizzle(env.DB).select().from(auditOutboxRejected);
  return rows.length;
};

/** The row core keeps of `personId`'s run sources of workflow `id`. */
const rowOf = async (personId: string, id: string) =>
  await env.DB.prepare(
    "SELECT in_use AS inUse, removal_owed AS owed, runs FROM brain_run_sources WHERE person_id = ? AND workflow_id = ?"
  )
    .bind(personId, id)
    .first<{ inUse: number; owed: number; runs: number | null }>();

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
 * The Brain's store binding, its removals recorded (the keys of each call,
 * in order) and every one after the first `through` failing, as a store
 * that goes out of reach part-way.
 */
const removalsFailingAfter = (
  through: number
): { binding: Env["BRAIN_STORE"]; calls: string[][] } => {
  const calls: string[][] = [];
  const stubOf = (stub: object): object =>
    new Proxy(stub, {
      get: (target, property) => {
        if (property !== "removeSources") {
          return forwarded(target, property);
        }
        return async (request: { sources: string[] }) => {
          if (calls.length >= through) {
            await Promise.resolve();
            throw new Error("The Brain is out of reach");
          }
          calls.push(request.sources);
          const removeSources: unknown = Reflect.get(target, property);
          if (typeof removeSources !== "function") {
            throw new TypeError("The store removes nothing");
          }
          await Reflect.apply(removeSources, target, [request]);
        };
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
  return { binding: namespaceOf(env.BRAIN_STORE), calls };
};

/**
 * The Brain's store binding, `personId`'s own store refusing every call, as
 * one person's store out of reach while everyone else's answers.
 */
const storeOfRefusing = (personId: string): Env["BRAIN_STORE"] => {
  const refusing = new Proxy(
    {},
    {
      get: () => async () => {
        await Promise.resolve();
        throw new Error("This person's store is out of reach");
      },
    }
  );
  const namespaceOf = (namespace: Env["BRAIN_STORE"]): Env["BRAIN_STORE"] =>
    new Proxy(namespace, {
      get: (target, property) => {
        if (property === "jurisdiction") {
          return (jurisdiction: DurableObjectJurisdiction) =>
            namespaceOf(target.jurisdiction(jurisdiction));
        }
        if (property === "getByName") {
          return (name: string) =>
            name.endsWith(personId) ? refusing : target.getByName(name);
        }
        return forwarded(target, property);
      },
    });
  return namespaceOf(env.BRAIN_STORE);
};

/** The Brain's store binding, every removal failing, as a store out of reach. */
const removalsFailing = (): Env["BRAIN_STORE"] =>
  removalsFailingAfter(0).binding;

/**
 * `count` more runs of run `runId`'s person and workflow, created when it
 * was, each with its own start receipt, as so many runs that ended would
 * be: copied row by row from it, a new ID each. Their IDs.
 */
const copiesOf = async (runId: string, count: number): Promise<string[]> => {
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  const copy = async (table: string, fresh: readonly string[]) => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM pragma_table_info(?)"
    )
      .bind(table)
      .all<{ name: string }>();
    const columns = results.map(({ name }) => name);
    const values = columns.map((name) =>
      fresh.includes(name) ? "ids.value" : `copied.${name}`
    );
    return env.DB.prepare(
      `INSERT INTO ${table} (${columns.join(", ")})
      SELECT ${values.join(", ")} FROM ${table} AS copied, json_each(?) AS ids
      WHERE copied.id = ?`
    ).bind(JSON.stringify(ids), runId);
  };
  await env.DB.batch([
    await copy("workflow_start_receipts", ["id", "idempotency_key"]),
    await copy("workflow_resource_runs", ["id"]),
  ]);
  return ids;
};

/** What `personId`'s own store has of run `runId`'s key. */
const keyStateOf = async (personId: string, runId: string) =>
  await personalBrainOf(
    inJurisdiction(env, env.BRAIN_STORE),
    personId
  ).keyState(`run:${runId}`);

/**
 * Core's database, its next batch that clears a removal owed failing
 * (`lost`: committed, then its answer lost), as D1 out of reach.
 */
const completionFailing = (how: "failed" | "lost"): D1Database => {
  let armed = false;
  let done = false;
  const real = env.DB;
  return {
    prepare: (query) => {
      armed ||= !done && /^update "brain_run_sources"/iu.test(query);
      return real.prepare(query);
    },
    batch: async <T>(statements: D1PreparedStatement[]) => {
      if (!armed) {
        return await real.batch<T>(statements);
      }
      armed = false;
      done = true;
      if (how === "failed") {
        throw new Error("D1 is out of reach");
      }
      await real.batch<T>(statements);
      throw new Error("The answer was lost");
    },
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
};

/**
 * An App of `owner`'s that starts workflow `workflowId`, granted by
 * `admin`, used by `user`, who holds no role in the workflow: `start`
 * starts a run for `user` as the App's code does, and answers its ID.
 */
const appStartingFor = async (
  owner: Identity,
  admin: Identity,
  workflowId: string,
  user: Identity
) => {
  const app = appIdSchema.parse(crypto.randomUUID());
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'Starter', '', ?, ?)"
    ).bind(app, owner.userId, Date.now()),
    env.DB.prepare(
      "INSERT INTO app_versions (app_id, version, tree, files, author_id, message, created_at, approved) VALUES (?, 1, 'tree', 0, ?, 'Version', ?, 1)"
    ).bind(app, owner.userId, Date.now()),
    env.DB.prepare(
      "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
    ).bind(app, user.userId, owner.userId, Date.now()),
  ]);
  await standInBinding(app, "flow", workflowId, owner);
  await granted(owner, admin, {
    subject: { type: "app", appId: app },
    object: {
      type: "workflow",
      workflowId: workflowResourceIdSchema.parse(workflowId),
    },
    actions: ["start"],
    binding: `START_${unique().toUpperCase().replaceAll("-", "_")}`,
  });
  // Out, so someone who only uses it may.
  await standInLive(app);
  const authority: Authority = {
    subject: { type: "app", appId: app },
    onBehalfOf: user.userId,
    mode: "interactive",
    appVersion: 1,
  };
  return {
    start: async (): Promise<string> => {
      const { runId } = await appWorkflowStarts(env, authority, null).start(
        "flow",
        { who: "Ada" },
        unique()
      );
      if (runId === null) {
        throw new Error("The start admitted no run");
      }
      return runId;
    },
  };
};

/** Waits until core's record of run `runId` says it ended. */
const endedInRecords = async (runId: string): Promise<void> => {
  await vi.waitFor(
    async () => {
      const row = await env.DB.prepare(
        "SELECT ended_at AS endedAt FROM workflow_resource_runs WHERE id = ?"
      )
        .bind(runId)
        .first<{ endedAt: number | null }>();
      expect(row?.endedAt, "the run never ended").not.toBeNull();
    },
    { timeout: 30_000, interval: 100 }
  );
};

describe("a person's run results once they lose the workflow", () => {
  it("are recalled, read and listed in history as never handed over, from the clock's next task, while the run page refuses them, and recorded once", async () => {
    const [owner, user] = await Promise.all([builder(), builder("user")]);
    const secret = word();
    const id = await sharedWorkflow(owner, secret, user);
    const runId = await endedRun(user, id);
    await handOverNow();
    const before = {
      recalls: await recalls(user.userId, secret, runId),
      reads: await readsOf(user.userId, runId),
    };

    await unshared(owner, id, user);
    const page = await outcome(resourceRunFor(env, user, id, runId));
    await removeLostRunSources(env);

    expect({
      before: {
        recalls: before.recalls,
        readsAsNever: before.reads.version === neverHandedOver.version,
      },
      page,
      after: {
        recalls: await recalls(user.userId, secret, runId),
        reads: await readsOf(user.userId, runId),
      },
      removals: await removalsOf(id),
    }).toStrictEqual({
      before: { recalls: true, readsAsNever: false },
      page: "workflow.resource_unavailable",
      after: { recalls: false, reads: neverHandedOver },
      // Its time the revocation's, as core stored it.
      removals: [
        {
          detail: { personId: user.userId, runs: 1 },
          at: await revokedAtOf(user.userId, id),
          actor: { type: "system" },
        },
      ],
    });
  });

  it("leave someone who keeps the role, and the workflow's owner, with theirs", async () => {
    const [owner, leaving, staying] = await Promise.all([
      builder(),
      builder("user"),
      builder("user"),
    ]);
    const secret = word();
    const id = await sharedWorkflow(owner, secret, leaving, staying);
    const [leavingRun, stayingRun, ownerRun] = await Promise.all([
      endedRun(leaving, id),
      endedRun(staying, id),
      endedRun(owner, id),
    ]);
    await handOverNow();

    await unshared(owner, id, leaving);
    await removeLostRunSources(env);

    expect({
      leaving: await recalls(leaving.userId, secret, leavingRun),
      staying: await recalls(staying.userId, secret, stayingRun),
      owner: await recalls(owner.userId, secret, ownerRun),
      removed: await removedOf(id),
    }).toStrictEqual({
      leaving: false,
      staying: true,
      owner: true,
      removed: [{ personId: leaving.userId, runs: 1 }],
    });
  });

  it("are taken out of use once they leave the team it is shared with, though the change itself told no one", async () => {
    const [owner, leaving, staying] = await Promise.all([
      builder(),
      builder("user"),
      builder("user"),
    ]);
    const teamId = crypto.randomUUID();
    await drizzle(env.DB)
      .insert(teams)
      .values({
        id: teamId,
        name: `Team ${teamId}`,
        organizationId,
        createdAt: new Date(),
      });
    await drizzle(env.DB)
      .insert(teamMembers)
      .values(
        [leaving, staying].map(({ userId }) => ({
          id: crypto.randomUUID(),
          teamId,
          userId,
          createdAt: new Date(),
        }))
      );
    const secret = word();
    const id = await sharedWorkflow(owner, secret);
    await shareWorkflowResource(env, owner, id, {
      type: "team",
      id: teamId,
      role: "user",
    });
    // Each as their membership is read now, their team among it.
    const [leavingRun, stayingRun] = await Promise.all(
      [leaving, staying].map(async ({ userId }) => {
        const now = await memberOf(env.DB, userId);
        if (now === undefined) {
          throw new Error("Not a member");
        }
        return await endedRun(now, id);
      })
    );
    await handOverNow();

    // Straight in the table, as Better Auth's own batch leaves it: no
    // statement of core's beside it.
    await drizzle(env.DB)
      .delete(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, leaving.userId)
        )
      );
    await removeLostRunSources(env);

    expect({
      leaving: await recalls(leaving.userId, secret, leavingRun ?? ""),
      staying: await recalls(staying.userId, secret, stayingRun ?? ""),
      removed: await removedOf(id),
    }).toStrictEqual({
      leaving: false,
      staying: true,
      removed: [{ personId: leaving.userId, runs: 1 }],
    });
  });

  it("are all taken out of use once the workflow is deleted, its owner's included", async () => {
    const [owner, user] = await Promise.all([builder(), builder("user")]);
    const secret = word();
    const id = await sharedWorkflow(owner, secret, user);
    const [userRun, ownerRun] = await Promise.all([
      endedRun(user, id),
      endedRun(owner, id),
    ]);
    await handOverNow();

    await deleteWorkflowResource(env, owner, id);
    await removeLostRunSources(env);
    const removed = await removedOf(id);

    expect({
      user: await recalls(user.userId, secret, userRun),
      owner: await recalls(owner.userId, secret, ownerRun),
      removed: removed
        .map(({ personId, runs }) => `${String(personId)}:${String(runs)}`)
        .toSorted(),
    }).toStrictEqual({
      user: false,
      owner: false,
      removed: [`${owner.userId}:1`, `${user.userId}:1`].toSorted(),
    });
  });

  it("stay out of use when the role comes back, while a new run's result is recalled", async () => {
    const [owner, user] = await Promise.all([builder(), builder("user")]);
    const secret = word();
    const id = await sharedWorkflow(owner, secret, user);
    const oldRun = await endedRun(user, id);
    await handOverNow();
    await unshared(owner, id, user);
    await removeLostRunSources(env);

    await shareWorkflowResource(env, owner, id, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const newRun = await endedRun(user, id);
    await handOverNow();
    // Another task with the role held: nothing more leaves use.
    await removeLostRunSources(env);

    expect({
      old: await recalls(user.userId, secret, oldRun),
      oldReads: await readsOf(user.userId, oldRun),
      new: await recalls(user.userId, secret, newRun),
      removals: await removalCountOf(id),
    }).toStrictEqual({
      old: false,
      oldReads: neverHandedOver,
      new: true,
      removals: 1,
    });
  });

  it("are never handed over for a run that ended after the loss", async () => {
    const [owner, user] = await Promise.all([builder(), builder("user")]);
    const secret = word();
    const id = await sharedWorkflow(owner, secret, user);
    const runId = await endedRun(user, id);

    await unshared(owner, id, user);
    await handOverNow();
    await removeLostRunSources(env);

    expect({
      endings: await endingsFor(runId),
      recalls: await recalls(user.userId, secret, runId),
      // Nothing of theirs was ever in use: nothing to take out of use.
      row: await rowOf(user.userId, id),
      removals: await removalsOf(id),
    }).toStrictEqual({
      endings: ["brain.source.handover_skipped:no_role"],
      recalls: false,
      row: null,
      removals: [],
    });
  });

  /**
   * Core's producers, losing `user` workflow `id`'s role and running the
   * clock's task between the attempt at run `runId` reading the run (the
   * role still held) and its add. Says whether it ran.
   */
  const losingMidway = (
    owner: Person,
    id: string,
    user: Person,
    runId: string
  ): { producers: Producers; raced: () => boolean } => {
    const core = producersOf(env);
    let raced = false;
    return {
      raced: () => raced,
      producers: {
        attempt: async (source) => {
          const attempt = await core.attempt(source);
          if (source.id === runId && !raced) {
            raced = true;
            await unshared(owner, id, user);
            await removeLostRunSources(env);
          }
          return attempt;
        },
      },
    };
  };

  it("refuse a hand-over that read the role before the loss and lands after the removal", async () => {
    const [owner, user] = await Promise.all([builder(), builder("user")]);
    const secret = word();
    const id = await sharedWorkflow(owner, secret, user);
    const earlierRun = await endedRun(user, id);
    await handOverNow();
    const lateRun = await endedRun(user, id);
    const losing = losingMidway(owner, id, user, lateRun);

    await handOverNow(losing.producers);

    expect({
      raced: losing.raced(),
      endings: await endingsFor(lateRun),
      recalls: [
        await recalls(user.userId, secret, earlierRun),
        await recalls(user.userId, secret, lateRun),
      ],
      reads: await readsOf(user.userId, lateRun),
    }).toStrictEqual({
      raced: true,
      endings: ["brain.source.handover_refused:removed"],
      recalls: [false, false],
      reads: neverHandedOver,
    });
  });

  it("take a first run's result that lands after the loss out of use at the next task", async () => {
    const [owner, user] = await Promise.all([builder(), builder("user")]);
    const secret = word();
    const id = await sharedWorkflow(owner, secret, user);
    const runId = await endedRun(user, id);
    // Nothing of theirs is in use yet when they lose the role: the task
    // midway has nothing to take out of use, and the add lands.
    const losing = losingMidway(owner, id, user, runId);
    await handOverNow(losing.producers);
    const landed = await endingsFor(runId);

    await removeLostRunSources(env);

    expect({
      raced: losing.raced(),
      landed,
      recalls: await recalls(user.userId, secret, runId),
      reads: await readsOf(user.userId, runId),
      removals: await removedOf(id),
    }).toStrictEqual({
      raced: true,
      landed: ["brain.source.handed_over"],
      recalls: false,
      reads: neverHandedOver,
      removals: [{ personId: user.userId, runs: 1 }],
    });
  });

  it("are taken out of use by the next task after the Brain was out of reach, recorded once", async () => {
    const [owner, user] = await Promise.all([builder(), builder("user")]);
    const secret = word();
    const id = await sharedWorkflow(owner, secret, user);
    const runId = await endedRun(user, id);
    await handOverNow();
    await unshared(owner, id, user);

    await removeLostRunSources({ ...env, BRAIN_STORE: removalsFailing() });
    const whileOut = {
      row: await rowOf(user.userId, id),
      removals: await removalsOf(id),
    };
    await removeLostRunSources(env);

    expect({
      whileOut,
      recalls: await recalls(user.userId, secret, runId),
      row: await rowOf(user.userId, id),
      removals: await removedOf(id),
    }).toStrictEqual({
      whileOut: { row: { inUse: 0, owed: 1, runs: 1 }, removals: [] },
      recalls: false,
      row: { inUse: 0, owed: 0, runs: 1 },
      removals: [{ personId: user.userId, runs: 1 }],
    });
  });

  it("are recorded exactly once when the record of the removal failed, or its answer was lost, and the next task completes it after a drain", async () => {
    const [owner, user] = await Promise.all([builder(), builder("user")]);
    const ids = await Promise.all(
      (["failed", "lost"] as const).map(async (how) => {
        const id = await sharedWorkflow(owner, word(), user);
        await endedRun(user, id);
        return { how, id };
      })
    );
    await handOverNow();
    const rejectedBefore = await rejectedCount();

    for (const { how, id } of ids) {
      // oxlint-disable-next-line no-await-in-loop -- one cut-off at a time
      await unshared(owner, id, user);
      // oxlint-disable-next-line no-await-in-loop -- one cut-off at a time
      await removeLostRunSources({ ...env, DB: completionFailing(how) });
    }
    // The log takes what was stored before the next task stores it again.
    await drainAuditOutboxes(env);
    await removeLostRunSources(env);
    await removeLostRunSources(env);

    expect({
      removals: await Promise.all(
        ids.map(async ({ id }) => await removalCountOf(id))
      ),
      rows: await Promise.all(
        ids.map(async ({ id }) => await rowOf(user.userId, id))
      ),
      rejected: (await rejectedCount()) - rejectedBefore,
    }).toStrictEqual({
      removals: [1, 1],
      rows: [
        { inUse: 0, owed: 0, runs: 1 },
        { inUse: 0, owed: 0, runs: 1 },
      ],
      rejected: 0,
    });
  });

  it("are marked again only once an earlier removal of theirs is complete, each loss recorded once", async () => {
    const [owner, user] = await Promise.all([builder(), builder("user")]);
    const secret = word();
    const id = await sharedWorkflow(owner, secret, user);
    const firstRun = await endedRun(user, id);
    await handOverNow();
    await unshared(owner, id, user);
    // The first loss stays owed: the Brain is out of reach.
    await removeLostRunSources({ ...env, BRAIN_STORE: removalsFailing() });
    // The role back, a new run handed over, and lost again.
    await shareWorkflowResource(env, owner, id, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const secondRun = await endedRun(user, id);
    await handOverNow();
    await unshared(owner, id, user);

    await removeLostRunSources(env);
    const afterOne = {
      first: await recalls(user.userId, secret, firstRun),
      removals: await removalCountOf(id),
    };
    await removeLostRunSources(env);

    expect({
      afterOne,
      first: await recalls(user.userId, secret, firstRun),
      second: await recalls(user.userId, secret, secondRun),
      removals: await removedOf(id),
    }).toStrictEqual({
      afterOne: { first: false, removals: 1 },
      first: false,
      second: false,
      removals: [
        // Each loss counts what it removed: the second, the one new run.
        { personId: user.userId, runs: 1 },
        { personId: user.userId, runs: 1 },
      ],
    });
  });

  it("are taken out of use a page at a time across ticks when they are more than one tick does, and recorded once", async () => {
    const [owner, user] = await Promise.all([builder(), builder("user")]);
    const secret = word();
    const id = await sharedWorkflow(owner, secret, user);
    const runId = await endedRun(user, id);
    await handOverNow();
    // Two and a half pages of runs in all, one page a tick.
    const copies = await copiesOf(runId, 2 * runRemovalsMax + 49);
    await unshared(owner, id, user);

    const ticks: { owed: number | undefined; removals: number }[] = [];
    for (let tick = 0; tick < 3; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one tick after another
      await removeLostRunSources(env, 1);
      // oxlint-disable-next-line no-await-in-loop -- one tick after another
      const row = await rowOf(user.userId, id);
      ticks.push({
        owed: row?.owed,
        // oxlint-disable-next-line no-await-in-loop -- one tick after another
        removals: await removalCountOf(id),
      });
    }

    expect({
      ticks,
      recalls: await recalls(user.userId, secret, runId),
      closed: [
        await keyStateOf(user.userId, copies[0] ?? ""),
        await keyStateOf(user.userId, copies.at(-1) ?? ""),
      ],
      removed: await removedOf(id),
    }).toStrictEqual({
      ticks: [
        { owed: 1, removals: 0 },
        { owed: 1, removals: 0 },
        { owed: 0, removals: 1 },
      ],
      recalls: false,
      closed: ["held", "held"],
      removed: [{ personId: user.userId, runs: copies.length + 1 }],
    });
  });

  it("go on from the last page kept when the store fails part-way, never sending it again", async () => {
    const [owner, user] = await Promise.all([builder(), builder("user")]);
    const id = await sharedWorkflow(owner, word(), user);
    const runId = await endedRun(user, id);
    await handOverNow();
    const copies = await copiesOf(runId, 2 * runRemovalsMax + 9);
    await unshared(owner, id, user);

    // One page goes through, then the store is out of reach.
    const partWay = removalsFailingAfter(1);
    await removeLostRunSources({ ...env, BRAIN_STORE: partWay.binding });
    const afterFailure = await rowOf(user.userId, id);
    const recovering = removalsFailingAfter(Number.POSITIVE_INFINITY);
    await removeLostRunSources({ ...env, BRAIN_STORE: recovering.binding });
    const first = new Set(partWay.calls.flat());
    const resent = recovering.calls.flat();

    expect({
      afterFailure,
      firstPage: first.size,
      sentAgain: resent.filter((key) => first.has(key)).length,
      sentInAll: new Set([...first, ...resent]).size,
      removals: await removalCountOf(id),
    }).toStrictEqual({
      afterFailure: { inUse: 0, owed: 1, runs: copies.length + 1 },
      firstPage: runRemovalsMax,
      sentAgain: 0,
      sentInAll: copies.length + 1,
      removals: 1,
    });
  });

  it("let a small revocation finish at its first tick beside a large one under way", async () => {
    const [owner, many, few] = await Promise.all([
      builder(),
      builder("user"),
      builder("user"),
    ]);
    const secret = word();
    const id = await sharedWorkflow(owner, secret, many, few);
    const [manyRun, fewRun] = await Promise.all([
      endedRun(many, id),
      endedRun(few, id),
    ]);
    await handOverNow();
    await copiesOf(manyRun, 3 * runRemovalsMax);
    await unshared(owner, id, many);
    // The large one begins first, and is older.
    await removeLostRunSources(env, 1);
    await unshared(owner, id, few);

    await removeLostRunSources(env, 1);

    expect({
      few: {
        row: await rowOf(few.userId, id),
        recalls: await recalls(few.userId, secret, fewRun),
      },
      many: await rowOf(many.userId, id),
      removed: await removedOf(id),
    }).toStrictEqual({
      few: { row: { inUse: 0, owed: 0, runs: 1 }, recalls: false },
      many: { inUse: 0, owed: 1, runs: 3 * runRemovalsMax + 1 },
      removed: [{ personId: few.userId, runs: 1 }],
    });
  });

  it("are recorded once when a hand-over that read the role before the loss ends after the loss was marked", async () => {
    const [owner, user] = await Promise.all([builder(), builder("user")]);
    const secret = word();
    const id = await sharedWorkflow(owner, secret, user);
    const earlierRun = await endedRun(user, id);
    await handOverNow();
    const lateRun = await endedRun(user, id);
    const core = producersOf(env);
    let marked = false;
    // Its add lands with the role held; before its ending batch, the role
    // is lost and the clock's task marks and completes the removal.
    const endingLate: Producers = {
      attempt: async (source) => {
        const attempt = await core.attempt(source);
        if (source.id !== lateRun) {
          return attempt;
        }
        return {
          ...attempt,
          ended: async (ending) => {
            if (!marked) {
              marked = true;
              await unshared(owner, id, user);
              await removeLostRunSources(env);
            }
            await attempt.ended(ending);
          },
        };
      },
    };

    await handOverNow(endingLate);
    await removeLostRunSources(env);
    await removeLostRunSources(env);

    expect({
      marked,
      endings: await endingsFor(lateRun),
      recalls: [
        await recalls(user.userId, secret, earlierRun),
        await recalls(user.userId, secret, lateRun),
      ],
      removed: await removedOf(id),
    }).toStrictEqual({
      marked: true,
      endings: ["brain.source.handed_over"],
      recalls: [false, false],
      removed: [{ personId: user.userId, runs: 2 }],
    });
  });

  it("leave the result of a run an App started for someone who uses the App out of their removal once they lose the workflow, while their own run follows the role", async () => {
    const [ada, admin, bob] = await Promise.all([
      person("builder"),
      person("admin"),
      person("user"),
    ]);
    const secret = word();
    const workflow = await published(
      ada,
      definitionOf([], { value: { status: secret } })
    );
    // While the workflow is shared with Bob: a run he starts himself, and
    // one the App starts for him. Both are handed over, and his own puts
    // the row of his role in use.
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: bob.userId,
      role: "user",
    });
    const ownRun = await endedRun(bob, workflow.id);
    const app = await appStartingFor(ada, admin, workflow.id, bob);
    const appRun = await app.start();
    await endedInRecords(appRun);
    await handOverNow();
    const before = {
      app: await recalls(bob.userId, secret, appRun),
      own: await recalls(bob.userId, secret, ownRun),
    };

    await unshared(ada, workflow.id, bob);
    await removeLostRunSources(env);

    expect({
      endings: {
        app: await endingsFor(appRun),
        own: await endingsFor(ownRun),
      },
      before,
      after: {
        app: await recalls(bob.userId, secret, appRun),
        own: await recalls(bob.userId, secret, ownRun),
      },
      removed: await removedOf(workflow.id),
    }).toStrictEqual({
      endings: {
        app: ["brain.source.handed_over"],
        own: ["brain.source.handed_over"],
      },
      before: { app: true, own: true },
      // The App shows him its run's result still: it stays his to recall.
      after: { app: true, own: false },
      removed: [{ personId: bob.userId, runs: 1 }],
    });
  });

  it("leave a run an App started for someone with no role in the workflow to be handed over", async () => {
    const [ada, admin, bob] = await Promise.all([
      person("builder"),
      person("admin"),
      person("user"),
    ]);
    const secret = word();
    const workflow = await published(
      ada,
      definitionOf([], { value: { status: secret } })
    );
    const app = await appStartingFor(ada, admin, workflow.id, bob);
    const appRun = await app.start();
    await endedInRecords(appRun);

    await handOverNow();
    await removeLostRunSources(env);

    expect({
      endings: await endingsFor(appRun),
      recalls: await recalls(bob.userId, secret, appRun),
      // The App's run puts no row of the workflow's role in use.
      row: await rowOf(bob.userId, workflow.id),
    }).toStrictEqual({
      endings: ["brain.source.handed_over"],
      recalls: true,
      row: null,
    });
  });

  it("give every owed revocation a turn before any gets a second, across ticks, so one person's store out of reach holds up no one else", async () => {
    const [owner, stuck, healthy] = await Promise.all([
      builder(),
      builder("user"),
      builder("user"),
    ]);
    // Two workflows of the person whose store is out of reach, a tick's
    // pages' worth, and one of a healthy person's behind them.
    const [first, second, other] = await Promise.all([
      sharedWorkflow(owner, word(), stuck),
      sharedWorkflow(owner, word(), stuck),
      sharedWorkflow(owner, word(), healthy),
    ]);
    await Promise.all([
      endedRun(stuck, first),
      endedRun(stuck, second),
      endedRun(healthy, other),
    ]);
    await handOverNow();
    await unshared(owner, first, stuck);
    await unshared(owner, second, stuck);
    // Marked first, with no page yet: the older revocations.
    await removeLostRunSources(env, 0);
    await unshared(owner, other, healthy);
    const outOfReach = { ...env, BRAIN_STORE: storeOfRefusing(stuck.userId) };

    await removeLostRunSources(outOfReach, 2);
    await removeLostRunSources(outOfReach, 2);

    expect({
      stuck: [
        await rowOf(stuck.userId, first),
        await rowOf(stuck.userId, second),
      ],
      healthy: await rowOf(healthy.userId, other),
      removed: await removedOf(other),
    }).toStrictEqual({
      stuck: [
        { inUse: 0, owed: 1, runs: 1 },
        { inUse: 0, owed: 1, runs: 1 },
      ],
      healthy: { inUse: 0, owed: 0, runs: 1 },
      removed: [{ personId: healthy.userId, runs: 1 }],
    });
  });
});
