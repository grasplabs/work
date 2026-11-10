import { sha256Hex, sha256HexOfBytes } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Role } from "@grasp-os/shared/roles";
import type {
  WorkflowResourceRun,
  WorkflowStart,
} from "@grasp-os/shared/workflow-resources";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, vi } from "vite-plus/test";
import { z } from "zod";

import type { Acting } from "../src/auth/identity.ts";
import { generatedModule } from "../src/workflow-builds.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { runEngine } from "../src/workflows/engine.ts";
import { admitAttempt } from "../src/workflows/quotas.ts";
import {
  repairResourceStarts,
  resourceRunFor,
} from "../src/workflows/resource-runs.ts";
import { allEvents } from "./audit-events.ts";
import { objectSchema } from "./json-workflow-apps.ts";
import { configuredLimits } from "./quota-limits.ts";
import { runObject, whileEngineRefuses } from "./runs.ts";
import { putArtifact } from "./sealed-apps.ts";
import { moduleOf } from "./sealed-run-harness.ts";
import { outcome, unique } from "./sign-in.ts";

/**
 * The harness of runs of JSON workflows, shared by the
 * workflow-resource-run*.test.ts files: builders, definitions published and
 * started, sealed builds forged, and what a run left read back from core
 * and the engine.
 */

/** A builder of the organization, as their session has them. */
export const builder = async (role: Role = "builder"): Promise<Acting> => {
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
  return { userId, role, teams: [], staff: false };
};

/** The output most definitions here return: a status. */
export const statusOutput = { status: { kind: "string" } };

/**
 * A grasp-workflow/2 definition running `steps` on input `{ who }`, its
 * output `value` of `output`'s fields: `{ status: "done" }` unless said.
 */
export const definitionOf = (
  steps: unknown[],
  {
    output = statusOutput,
    value = { status: "done" },
  }: { output?: Record<string, unknown>; value?: unknown } = {}
): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ who: { kind: "string" } }),
    returns: objectSchema(output),
    result: value,
    params: {
      greeting: {
        label: "Greeting",
        type: { kind: "string", default: "Hello" },
        sensitive: false,
      },
    },
    steps,
  });

/** The greeting `params.greeting + ", " + args.who`, as an expression. */
export const greeting = { $expr: 'params.greeting + ", " + args.who' };

/** A run that waits an hour, then ends with `{ status: "done" }`. */
export const waitingDefinition = definitionOf([
  { id: "pause", type: "wait", for: "1 hour" },
]);

/**
 * A run whose output's expression fails: it reads a letter its input's
 * `who` hasn't.
 */
export const failingDefinition = definitionOf([], {
  value: { status: { $expr: 'args.who.split("")[9999].toUpperCase()' } },
});

/** A workflow of `by`'s, published once from `definition`. */
export const published = async (by: Acting, definition: string) => {
  const workflow = await createWorkflowResource(env, by, `run-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition,
    basedOn: null,
  });
  return workflow;
};

/**
 * Seals `code` as version 1 of workflow `id`'s generated module, as if the
 * compiler had made it: its artifact, the build's identity and the
 * manifest's hash all made to match, past the records' immutability.
 */
export const forgedModule = async (id: string, code: string): Promise<void> => {
  const row = await env.DB.prepare(
    "SELECT manifest FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
  )
    .bind(id)
    .first<{ manifest: string }>();
  const manifest = z
    .looseObject({
      build: z.looseObject({
        generator: z.string(),
        compilerVersion: z.string(),
        hash: z.string(),
        artifacts: z.array(
          z.looseObject({
            path: z.string(),
            sha256: z.string(),
            bytes: z.number(),
          })
        ),
      }),
    })
    .parse(JSON.parse(row?.manifest ?? "{}"));
  const bytes = new TextEncoder().encode(code);
  const sha256 = await sha256HexOfBytes(bytes);
  await putArtifact(sha256, bytes);
  const { build } = manifest;
  build.artifacts = build.artifacts.map((artifact) =>
    artifact.path === `modules/${generatedModule}`
      ? { ...artifact, sha256, bytes: bytes.byteLength }
      : artifact
  );
  build.hash = await sha256Hex(
    canonicalJson({
      generator: build.generator,
      compilerVersion: build.compilerVersion,
      artifacts: build.artifacts
        // As workflow-builds.ts names it: not the definition or source map.
        .filter(
          ({ path }) =>
            path !== "source/workflow.json" && path !== "source-map.json"
        )
        .map(({ path, sha256: hash, bytes: size }) => ({
          path,
          sha256: hash,
          bytes: size,
        })),
    })
  );
  const text = canonicalJson(z.json().parse(manifest));
  await env.DB.batch([
    env.DB.prepare("DROP TRIGGER workflow_resource_versions_immutable_update"),
    env.DB.prepare(
      "UPDATE workflow_resource_versions SET manifest = ?, manifest_hash = ? WHERE workflow_resource_id = ? AND version = 1"
    ).bind(text, await sha256Hex(text), id),
    env.DB.prepare(
      "CREATE TRIGGER workflow_resource_versions_immutable_update BEFORE UPDATE ON workflow_resource_versions BEGIN SELECT RAISE(ABORT, 'workflow_resource_versions are immutable'); END"
    ),
  ]);
};

/** `by` starts version 1 of workflow `id` for Ada, under `key`. */
export const start = async (
  by: Acting,
  id: string,
  key = unique()
): Promise<WorkflowStart> =>
  await startWorkflow(env, { type: "person", person: by }, id, {
    version: 1,
    input: { who: "Ada" },
    key,
  });

/** Run `runId` of workflow `id`, once it has ended. */
export const ended = async (
  by: Acting,
  id: string,
  runId: string | null
): Promise<WorkflowResourceRun> =>
  await vi.waitFor(
    async () => {
      const run = await resourceRunFor(env, by, id, runId);
      expect(run.endedAt).not.toBeNull();
      return run;
    },
    { timeout: 30_000, interval: 100 }
  );

/** Run `id`'s row's `column`, as the repair and the trigger see it. */
export const runColumn = async (
  id: string | null,
  column:
    | "status"
    | "start_attempts"
    | "created_at"
    | "ended_at"
    | "manifest_hash"
    | "next_start_at"
    | "failure_code"
    | "summary_revision"
): Promise<unknown> => {
  const row = await env.DB.prepare(
    `SELECT ${column} AS value FROM workflow_resource_runs WHERE id = ?`
  )
    .bind(id)
    .first<{ value: unknown }>();
  return row?.value;
};

/** Where the engine has run `id` now; none before it has the run. */
export const engineStatus = async (id: string | null) => {
  const live = await runEngine(env).status(id ?? "");
  return live?.status;
};

/** Once the engine has run `id` somewhere other than `running` or `queued`. */
export const settledInEngine = async (id: string | null) =>
  await vi.waitFor(
    async () => {
      const status = await engineStatus(id);
      expect(["waiting", "complete", "errored", "terminated"]).toContain(
        status
      );
      return status;
    },
    { timeout: 30_000, interval: 100 }
  );

/** A workflow of `by`'s whose run waits an hour before it finishes. */
export const waitingWorkflow = async (by: Acting) =>
  await published(by, waitingDefinition);

/** Runs the start repair at `when` while every engine lookup fails. */
export const repairWhileLookupsFail = async (when: number): Promise<void> => {
  await whileEngineRefuses(
    (method) => method === "status",
    async () => {
      await repairResourceStarts(env, new Date(when));
    }
  );
};

/** `runId`'s audited events named `action`. */
export const runEvents = async (runId: string | null, action: string) => {
  const events = await allEvents();
  return events.filter(
    (event) => event.action === action && event.target?.id === runId
  );
};

/** A year ago: long past any run retention. */
export const yearAgo = (): number => Date.now() - 365 * 86_400_000;

/**
 * `count` starts of workflow `workflowId` by `by`, admitted a year ago:
 * each with a run that ended then (`ran`), or none (its version had no
 * executable build). Answers their IDs.
 */
export const oldStarts = async (
  by: Acting,
  workflowId: string,
  count: number,
  ran: boolean
): Promise<string[]> => {
  const prefix = `old-${unique()}`;
  await env.DB.batch([
    env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO workflow_start_receipts (id, invoker_type, invoker_id, idempotency_key, workflow_resource_id, workflow_resource_version, manifest_hash, principal_id, authority_generation, input, input_hash, params, params_revision, bindings, bindings_hash, created_at, restricted)
      SELECT ? || '-' || i, 'person', ?, ? || '-' || i, ?, 1, 'manifest', ?, 0, '{}', 'hash', '{}', 0, '[]', '', ?, 0 FROM n`
    ).bind(count, prefix, by.userId, prefix, workflowId, by.userId, yearAgo()),
    ...(ran
      ? [
          env.DB.prepare(
            `INSERT INTO workflow_resource_runs (id, workflow_resource_id, version, manifest_hash, build_hash, principal_id, status, created_at, ended_at, restricted)
            SELECT id, workflow_resource_id, 1, 'manifest', 'build', principal_id, 'completed', created_at, created_at, 0
            FROM workflow_start_receipts WHERE id LIKE ? || '-%'`
          ).bind(prefix),
        ]
      : []),
  ]);
  return Array.from({ length: count }, (_, at) => `${prefix}-${at + 1}`);
};

/** Which of `ids` have their start's details removed. */
export const startsSwept = async (
  ids: readonly string[]
): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    "SELECT id FROM workflow_start_receipts WHERE id IN (SELECT value FROM json_each(?)) AND details_removed_at IS NOT NULL"
  )
    .bind(JSON.stringify(ids))
    .all<{ id: string }>();
  return results.map(({ id }) => id).toSorted();
};

/**
 * Holds the notifications run `id`'s object hands core until `released`
 * settles: as late as delivery may be, the engine on with the run.
 */
export const holdNotifications = async (
  id: string,
  released: Promise<null>
): Promise<void> => {
  await runInDurableObject(runObject(id), (instance: object) => {
    const notify: unknown = Reflect.get(instance, "notify");
    if (typeof notify !== "function") {
      throw new TypeError("The run's object takes no notifications");
    }
    Reflect.set(instance, "notify", async (...args: unknown[]) => {
      await released;
      const taken: unknown = await Reflect.apply(notify, instance, args);
      return taken;
    });
  });
};

// The lineage quotas of runs of JSON workflows (workflows/quotas.ts), as an
// App's runs have them: each run is the root of its own lineage, and each
// of its steps' attempts is admitted against it and the client's shares of
// attempts running at once, then settled with what it used. The engine,
// the isolate, the host and core's database are real; the Loader's CPU
// kill is stood in for (cpu-kills.ts), as plain workerd enforces none.

/**
 * What `run` returns with the quota limits `limits` lowered; the
 * deployment's own again after.
 */
export const withQuotas = async <Result>(
  limits: Record<string, number>,
  run: () => Promise<Result>
): Promise<Result> => {
  env.TEST_QUOTA_LIMITS = limits;
  try {
    return await run();
  } finally {
    env.TEST_QUOTA_LIMITS = configuredLimits;
  }
};

export const lineageSchema = z.object({
  createdAt: z.number(),
  used: z.number(),
  held: z.number(),
  hostCalls: z.number(),
  descendants: z.number(),
});

/** Run `id`'s lineage counters, as core's database has them. */
export const lineageOf = async (id: string | null) =>
  lineageSchema
    .optional()
    .parse(
      (await env.DB.prepare(
        "SELECT created_at AS createdAt, active_used_ms AS used, active_held_ms AS held, host_calls AS hostCalls, descendants FROM run_lineages WHERE root_run_id = ?"
      )
        .bind(id)
        .first()) ?? undefined
    );

export const receiptSchema = z.object({
  key: z.string(),
  attempt: z.number(),
  root: z.string(),
  settled: z.number(),
  reserved: z.number(),
  used: z.number().nullable(),
  admittedAt: z.number(),
  deadline: z.number(),
  hostCalls: z.number(),
  resource: z.string(),
});

/** The receipts of run `id`'s attempts, in the order they were admitted. */
export const receiptsOf = async (id: string | null) => {
  const { results } = await env.DB.prepare(
    "SELECT step_key AS key, attempt, root_run_id AS root, settled_at IS NOT NULL AS settled, reserved_ms AS reserved, used_ms AS used, admitted_at AS admittedAt, deadline, host_calls AS hostCalls, resource FROM run_lineage_attempts WHERE run_id = ? ORDER BY admitted_at, attempt"
  )
    .bind(id)
    .all();
  return z.array(receiptSchema).parse(results);
};

/** An attempt key's step: `<engine run>:do:<count>:<step>`. */
export const keyStep = /^.*?:do:\d+:/u;

/** The step of attempt key `key`. */
export const stepOfKey = (key: string): string => key.replace(keyStep, "");

/** How many times run `id` waited for load, as its journal has it. */
export const loadWaitsOf = async (id: string | null): Promise<number> =>
  await runInDurableObject(
    runObject(id ?? ""),
    (_object, state) =>
      state.storage.sql
        .exec<{ waits: number }>(
          "SELECT count(*) AS waits FROM steps WHERE type IN ('sleep', 'waitForEvent') AND name LIKE '%:busy:%'"
        )
        .one().waits
  );

/**
 * A step `id` that records one thing and calls nothing: a wait until a
 * deadline long past, its enter step one attempt (an `if` has no step of
 * its own).
 */
export const deciding = (id: string) => ({
  id,
  type: "wait",
  until: { $expr: "0" },
});

/**
 * Two steps, `greet` and `call`, each deciding its `if`, then the
 * greeting called out.
 */
export const greetThenCall = definitionOf(
  [deciding("greet"), deciding("call")],
  {
    value: { status: { $expr: 'params.greeting + ", " + args.who + "!"' } },
  }
);

/**
 * A module, sealed as the generated one, whose step of task `finish`
 * never returns: its attempt holds what it was admitted with until the
 * engine fences it.
 */
export const hangingModule = moduleOf(`
await step.do("finish", { key: "enter", description: "finish" }, async () => await new Promise(() => {}));
return { status: "never" };`);

/** The receipt of run `id`'s attempt at `hangingModule`'s step. */
export const heldBy = async (id: string | null) => {
  const receipts = await receiptsOf(id);
  return receipts.find(({ key }) => stepOfKey(key) === "finish:enter");
};

/**
 * An attempt of run `run` of workflow `workflowId`'s, of activation
 * `generation`, admitted late: how its admission came out.
 */
export const late = async (
  run: string | null,
  workflowId: string,
  generation: number
) =>
  await outcome(
    admitAttempt(
      env,
      {
        run: run ?? "",
        root: run ?? "",
        resource: `workflow-resource:${workflowId}`,
      },
      {
        key: `late:${unique()}`,
        number: 1,
        generation,
        deadline: Date.now() + 60_000,
      }
    )
  );
