import type { Role } from "@grasp-os/shared/roles";
import { workflowStateMaxBytes } from "@grasp-os/shared/workflow-resources";
import { stepIdempotencyKey } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import {
  workflowResourceRuns,
  workflowStartReceipts,
} from "../src/db/core/schema.ts";
import { shareWorkflowResource } from "../src/workflow-members.ts";
import {
  createWorkflowResource,
  deleteWorkflowResource,
} from "../src/workflow-resources.ts";
import {
  readWorkflowState,
  resetWorkflowState,
  workflowStateOf,
  writeWorkflowState,
} from "../src/workflow-state.ts";
import { auditedDuring, outcome, unique } from "./sign-in.ts";

// What a workflow keeps between its runs (src/workflow-state.ts), from
// its threat model: one workflow reading or writing another's state; a
// value too large, alone or with what other runs kept; a step that wrote
// writing again when it is replayed or tried again; a write by a run that
// ended or isn't the workflow's own; someone without the edit right
// resetting it; values reaching the audit log; and state outliving its
// workflow. Runs are set up as core keeps them, as their own tests make
// them; the run host's calls are the functions it calls.

/** A member of the organization in `role`, as their session has them. */
const person = async (role: Role, staff = false): Promise<Acting> => {
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
  return { userId, role, teams: [], staff };
};

/** A workflow Ada builds, which Uma uses. */
const counting = async () => {
  const ada = await person("builder");
  const uma = await person("user");
  const workflow = await createWorkflowResource(env, ada, `count-${unique()}`);
  await shareWorkflowResource(env, ada, workflow.id, {
    type: "person",
    id: uma.userId,
    role: "user",
  });
  return { ada, uma, workflow };
};

/** A running run of `workflowId`, for `principal`, restricted for good if `restricted`. */
const running = async (
  workflowId: string,
  principal: Acting,
  restricted = false
): Promise<string> => {
  const id = crypto.randomUUID();
  const db = drizzle(env.DB);
  await db.insert(workflowStartReceipts).values({
    id,
    invokerType: "person",
    invokerId: principal.userId,
    idempotencyKey: unique(),
    workflowResourceId: workflowId,
    workflowResourceVersion: 1,
    manifestHash: "manifest",
    principalId: principal.userId,
    authorityGeneration: 0,
    inputHash: "input",
    restricted,
    createdAt: new Date(),
  });
  await db.insert(workflowResourceRuns).values({
    id,
    workflowResourceId: workflowId,
    version: 1,
    manifestHash: "manifest",
    buildHash: "build",
    principalId: principal.userId,
    status: "running",
    createdAt: new Date(),
    restricted,
  });
  return id;
};

/** Ends run `id`, completed. */
const ended = async (id: string): Promise<void> => {
  await drizzle(env.DB)
    .update(workflowResourceRuns)
    .set({ status: "completed", endedAt: new Date() })
    .where(eq(workflowResourceRuns.id, id));
};

/** Run `run`'s write at its step `step`, as the run host makes it. */
const write = async (
  run: string,
  step: string,
  values: Record<string, unknown>
): Promise<string> =>
  await outcome(
    // SAFETY: the values are what a run's isolate could send: anything.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    writeWorkflowState(env, run, stepIdempotencyKey(run, step), values as never)
  );

/** The entries `by` reads of workflow `id`'s state, without their times. */
const entriesFor = async (by: Acting, id: string) => {
  const { entries } = await readWorkflowState(env, by, id);
  return entries.map(({ key, value, runId }) => ({ key, value, runId }));
};

/** How many bytes workflow `id`'s state takes, as `by` reads it. */
const bytesFor = async (by: Acting, id: string): Promise<number> => {
  const { bytes } = await readWorkflowState(env, by, id);
  return bytes;
};

describe("a workflow's state", () => {
  it("is its own: a run writes only its own workflow's, and only its builders and admins read it", async () => {
    const { ada, uma, workflow } = await counting();
    const other = await counting();
    const stranger = await person("builder");
    const admin = await person("admin");
    // Another user of it, whose runs these aren't: what one person's run
    // kept is no other user's to read, as its results aren't.
    const ivy = await person("user");
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: ivy.userId,
      role: "user",
    });
    const run = await running(workflow.id, uma);
    const theirs = await running(other.workflow.id, other.uma);
    // A step's key names its run: one of another run is never taken.
    const anothersKey = await outcome(
      writeWorkflowState(env, run, stepIdempotencyKey(theirs, "count"), {
        cursor: 99,
      })
    );

    expect({
      written: await write(run, "count", { cursor: 5, seen: ["a", "b"] }),
      anothersKey: anothersKey.includes("another run"),
      unknownRun: await write(crypto.randomUUID(), "count", { cursor: 1 }),
      ours: await workflowStateOf(env, workflow.id),
      theirs: await workflowStateOf(env, other.workflow.id),
      forUma: await outcome(readWorkflowState(env, uma, workflow.id)),
      forIvy: await outcome(readWorkflowState(env, ivy, workflow.id)),
      forAdmin: await entriesFor(admin, workflow.id),
      forStranger: await outcome(readWorkflowState(env, stranger, workflow.id)),
      resetByStranger: await outcome(
        resetWorkflowState(env, stranger, workflow.id)
      ),
      forAda: await entriesFor(ada, workflow.id),
    }).toStrictEqual({
      written: "ok",
      anothersKey: true,
      unknownRun: "workflow.run_unavailable",
      ours: { cursor: 5, seen: ["a", "b"] },
      theirs: {},
      forUma: "role.forbidden",
      forIvy: "role.forbidden",
      forAdmin: [
        { key: "cursor", value: 5, runId: run },
        { key: "seen", value: ["a", "b"], runId: run },
      ],
      forStranger: "workflow.resource_unavailable",
      resetByStranger: "workflow.resource_unavailable",
      forAda: [
        { key: "cursor", value: 5, runId: run },
        { key: "seen", value: ["a", "b"], runId: run },
      ],
    });
  });

  it("refuses values that aren't named JSON, and lands nothing of them", async () => {
    const { uma, workflow } = await counting();
    const run = await running(workflow.id, uma);

    expect({
      dotted: await write(run, "a", { "state.cursor": 1 }),
      digit: await write(run, "b", { "1st": 1 }),
      notJson: await write(run, "c", { at: new Date(0) }),
      state: await workflowStateOf(env, workflow.id),
    }).toStrictEqual({
      dotted: "workflow.state_invalid",
      digit: "workflow.state_invalid",
      notJson: "workflow.state_invalid",
      state: {},
    });
  });

  it("holds 64 KB in all: past it, alone or with what other runs kept, a write is refused whole", async () => {
    const { ada, uma, workflow } = await counting();
    const first = await running(workflow.id, uma);
    const second = await running(workflow.id, uma);
    const half = "x".repeat(workflowStateMaxBytes / 2);

    expect({
      alone: await write(first, "big", { blob: `${half}${half}` }),
      firstHalf: await write(first, "half", { one: half }),
      // Each fits; with what the first run kept, it doesn't.
      secondHalf: await write(second, "half", { two: half, small: 1 }),
      // Overwriting a key counts its new value, not both.
      replaced: await write(second, "again", { one: "short" }),
      state: Object.keys(await workflowStateOf(env, workflow.id)),
      bytes: await bytesFor(ada, workflow.id),
    }).toStrictEqual({
      alone: "workflow.state_too_large",
      firstHalf: "ok",
      secondHalf: "workflow.state_too_large",
      replaced: "ok",
      state: ["one"],
      bytes: "one".length + JSON.stringify("short").length,
    });
  });

  it("is written once per step: a replay or a retry writes nothing again, even after a reset or another run's write", async () => {
    const { ada, uma, workflow } = await counting();
    const run = await running(workflow.id, uma);
    const later = await running(workflow.id, uma);

    const events = await auditedDuring(async () => {
      await write(run, "count", { n: 1, kept: true });
      // Last write wins across runs, key by key: nothing merges.
      await write(later, "count", { n: 2 });
      // The first run's step replayed, or tried again after a crash.
      await write(run, "count", { n: 3 });
    });
    const afterReplay = await workflowStateOf(env, workflow.id);
    await resetWorkflowState(env, ada, workflow.id);
    const replayAfterReset = await write(run, "count", { n: 4 });

    expect({
      afterReplay,
      replayAfterReset,
      afterReset: await workflowStateOf(env, workflow.id),
      written: events
        .filter(({ action }) => action === "workflow.state.written")
        .map(({ target, detail }) => ({
          run: target?.id,
          step: detail?.step,
          keys: detail?.keys,
        })),
    }).toStrictEqual({
      afterReplay: { n: 2, kept: true },
      replayAfterReset: "ok",
      afterReset: {},
      written: [
        { run, step: "count", keys: 2 },
        { run: later, step: "count", keys: 1 },
      ],
    });
  });

  it("takes nothing from a restricted run, so what it read never reaches the workflow's next run", async () => {
    const { ada, uma, workflow } = await counting();
    const run = await running(workflow.id, uma, true);

    const refused = await write(run, "count", { lastInvoice: "secret" });
    const next = await running(workflow.id, uma);

    expect({
      refused,
      nextRunReads: await workflowStateOf(env, workflow.id),
      kept: await entriesFor(ada, workflow.id),
      laterWrite: await write(next, "count", { n: 1 }),
    }).toStrictEqual({
      refused: "workflow.state_restricted",
      nextRunReads: {},
      kept: [],
      laterWrite: "ok",
    });
  });

  it("takes no write from a run that ended, or once its workflow is gone, and goes with its workflow", async () => {
    const { ada, uma, workflow } = await counting();
    const run = await running(workflow.id, uma);
    await write(run, "count", { n: 1 });
    await ended(run);
    const afterEnd = await write(run, "next", { n: 2 });
    await deleteWorkflowResource(env, ada, workflow.id);
    const kept = await env.DB.prepare(
      "SELECT (SELECT count(*) FROM workflow_state WHERE workflow_resource_id = ?1) + (SELECT count(*) FROM workflow_state_writes WHERE workflow_resource_id = ?1) AS n"
    )
      .bind(workflow.id)
      .first<{ n: number }>();

    expect({ afterEnd, kept: kept?.n }).toStrictEqual({
      afterEnd: "workflow.run_ended",
      kept: 0,
    });
  });

  it("is reset only by its builders, never Grasp staff, audited without a value", async () => {
    const { ada, uma, workflow } = await counting();
    const staff = { ...(await person("admin")), staff: true };
    const run = await running(workflow.id, uma);
    const secret = `invoice-${unique()}`;

    const events = await auditedDuring(async () => {
      await write(run, "count", { last: secret });
      await resetWorkflowState(env, ada, workflow.id);
    });

    expect({
      byUser: await outcome(resetWorkflowState(env, uma, workflow.id)),
      byStaff: await outcome(resetWorkflowState(env, staff, workflow.id)),
      state: await readWorkflowState(env, ada, workflow.id),
      actions: events
        .map(({ action }) => action)
        .filter((action) => action.startsWith("workflow.state")),
      valueLogged: JSON.stringify(events).includes(secret),
    }).toStrictEqual({
      byUser: "role.forbidden",
      byStaff: "role.forbidden",
      state: { entries: [], bytes: 0 },
      actions: ["workflow.state.written", "workflow.state.reset"],
      valueLogged: false,
    });
  });
});
