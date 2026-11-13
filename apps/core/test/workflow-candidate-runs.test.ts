import { v } from "@grasp-os/runtime/app";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  maxCandidateFixtureBytes,
  maxCandidateLifetimeMs,
  maxKeptCandidateRuns,
  maxLiveCandidateRuns,
} from "@grasp-os/shared/workflow-resources";
import type { WorkflowCandidateRun } from "@grasp-os/shared/workflow-resources";
import { stepIdempotencyKey } from "@grasp-os/shared/workflows";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { sweepReleases } from "../src/release-retention.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { editWorkflowDraft, workflowDraft } from "../src/workflow-editor.ts";
import { setWorkflowParams } from "../src/workflow-params.ts";
import { publishWorkflowVersion } from "../src/workflow-publish.ts";
import {
  createWorkflowResource,
  deleteWorkflowResource,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import { workflowStateOf, writeWorkflowState } from "../src/workflow-state.ts";
import {
  candidateRunFor,
  startCandidateRun,
  sweepCandidateRuns,
  terminateCandidateRun,
} from "../src/workflows/candidate-runs.ts";
import { runEngine } from "../src/workflows/engine.ts";
import { allEvents } from "./audit-events.ts";
import { withCpuKills } from "./cpu-kills.ts";
import { objectSchema } from "./json-workflow-apps.ts";
import { whileEngineRefuses } from "./runs.ts";
import { outcome, unique } from "./sign-in.ts";

// Test runs of a workflow's draft (workflows/candidate-runs.ts),
// from their threat model: a test run makes no call of any kind, a call
// with no answer fails it, its parameters are never the values stored on
// the workflow (a sensitive one above all), it runs only the draft at the
// revision it names, once it passes, verified, starts nothing else, and only builders start or read
// one.

const identityOf = (userId: string, role: Role, staff = false): Identity => ({
  userId,
  email: `${userId}@acme.test`,
  name: "Person",
  role,
  teams: [],
  staff,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});

/** A member of the organization with `role`, as their session has them. */
const person = async (role: Role, staff = false): Promise<Identity> => {
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
  return identityOf(userId, role, staff);
};

/**
 * A definition: its permissions, parameters and steps, and what its `status`
 * ends as (an expression), `args.who` by default.
 */
interface Definition {
  readonly permissions?: Record<string, unknown>;
  readonly params?: Record<string, unknown>;
  readonly steps?: readonly unknown[];
  readonly status?: string;
}

/** `definition` as a grasp-workflow/2 document. */
const definitionOf = ({
  permissions = {},
  params = {},
  steps = [],
  status = "args.who",
}: Definition): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ who: { kind: "string" } }),
    returns: objectSchema({ status: { kind: "string" } }),
    result: { status: { $expr: status } },
    params,
    permissions,
    steps,
  });

/**
 * A workflow of `by`'s whose draft holds the source `sourceOf` writes for
 * its name, checked: its revision. With `publish`, version
 * 1 is published from it first, so its parameters can be set.
 */
const draftedSource = async (
  by: Identity,
  sourceOf: (name: string) => string,
  { publish = false }: { publish?: boolean } = {}
) => {
  const workflow = await createWorkflowResource(env, by, `test-${unique()}`);
  const source = sourceOf(workflow.name);
  if (publish) {
    await publishWorkflowVersion(env, by, workflow.id, {
      definition: source,
      basedOn: null,
    });
  }
  const { revision: base } = await workflowDraft(env, by, workflow.id);
  const saved = await editWorkflowDraft(env, by, workflow.id, {
    revision: base,
    source,
  });
  expect(saved.problems).toStrictEqual([]);
  return { workflow, revision: saved.revision };
};

/** `draftedSource`, of `definition`. */
const drafted = async (
  by: Identity,
  definition: Definition,
  options: { publish?: boolean } = {}
) => await draftedSource(by, () => definitionOf(definition), options);

/** Test run `runId` of workflow `id` once it ended, as `by` reads it. */
const ended = async (
  by: Identity,
  id: string,
  runId: string
): Promise<WorkflowCandidateRun> =>
  await vi.waitFor(
    async () => {
      const run = await candidateRunFor(env, by, id, runId);
      if (run.status === "starting" || run.status === "running") {
        throw new Error(`Test run ${runId} is ${run.status}`);
      }
      return run;
    },
    { timeout: 20_000, interval: 100 }
  );

/** How run `run` ended: its status, and its output or error code. */
const endOf = (run: WorkflowCandidateRun) =>
  run.status === "completed"
    ? { status: run.status, output: run.result }
    : { status: run.status, code: run.error?.code };

/** What the audit log says any call of run `runId` reached. */
const callsOf = async (runId: string) => {
  const events = await allEvents();
  return events.filter(
    ({ action, target, detail }) =>
      (target?.id === runId &&
        (action === "workflow.run.called" ||
          action === "workflow.run.call_refused")) ||
      (action === "connection.call" && detail?.run === runId)
  );
};

/** The audit actions of a run's ends. */
const endActions = new Set([
  "workflow.run.completed",
  "workflow.run.failed",
  "workflow.run.cancelled",
]);

/** How the audit log says test run `runId` ended, each time it says so. */
const endsOf = async (runId: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, detail }) => endActions.has(action) && detail?.run === runId
    )
    .map(({ action, target, detail }) => ({
      action,
      target,
      candidate: detail?.candidate,
      ...(detail?.failureCode === undefined
        ? {}
        : { failureCode: detail.failureCode }),
    }));
};

/** The descriptor of an object of string `fields`, as the catalog holds one. */
const descriptor = (fields: Record<string, string>): string =>
  JSON.stringify(
    v.object(
      Object.fromEntries(Object.keys(fields).map((name) => [name, v.string()]))
    ).descriptor
  );

/** `ms` from now. */
const later = (ms: number): Date => new Date(Date.now() + ms);

/** A count of `sql`'s rows, bound to `values`. */
const countOf = async (sql: string, ...values: string[]): Promise<number> => {
  const row = await env.DB.prepare(sql)
    .bind(...values)
    .first<{ n: number }>();
  return row?.n ?? 0;
};

/**
 * Runs `update` on a row the database's `trigger` keeps from changing, as
 * only a write around the platform could: the trigger dropped and put back
 * in the same transaction.
 */
const aroundTrigger = async (
  trigger: string,
  update: D1PreparedStatement
): Promise<void> => {
  const kept = await env.DB.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?"
  )
    .bind(trigger)
    .first<{ sql: string }>();
  if (kept === null) {
    throw new Error(`No trigger ${trigger}`);
  }
  await env.DB.batch([
    env.DB.prepare(`DROP TRIGGER ${trigger}`),
    update,
    env.DB.prepare(kept.sql),
  ]);
};

/** A catalog contract of `kind` published by `admin`: its key. */
const contract = async (
  admin: Identity,
  kind: "connector" | "model" | "knowledge" | "files"
): Promise<string> => {
  const key = `${kind}-${unique()}`;
  await publishCatalogContract(
    env,
    admin,
    kind === "connector"
      ? {
          key,
          kind,
          operations: {
            "mail.send": {
              input: descriptor({ to: "string", subject: "string" }),
              output: descriptor({ messageId: "string" }),
            },
          },
        }
      : { key, kind }
  );
  return key;
};

/** A step sending mail through binding `mail`, its subject `subject`. */
const send = (subject = "Hello") => ({
  id: "send",
  type: "call",
  connection: "mail",
  action: "mail.send",
  args: { to: { $expr: "args.who" }, subject },
});

/** A step asking binding `summary` to greet. */
const greet = {
  id: "greet",
  type: "generate",
  instructions: "Greet them.",
  input: { who: { $expr: "args.who" } },
  returns: objectSchema({ line: { kind: "string" } }),
};

/** A step waiting `span`. */
const hold = (span: string, id = "hold") => ({ id, type: "wait", for: span });

describe("test runs of a workflow's draft", () => {
  it("answers each kind of call from its fixture, checked as a real answer is, and fails at a call it has no answer for, calling nothing", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const keys = {
      connector: await contract(admin, "connector"),
      model: await contract(admin, "model"),
    };
    const cases: {
      kind: string;
      definition: Definition;
      alias: string;
      answer: Record<string, string>;
      status: string;
    }[] = [
      {
        kind: "connector",
        definition: {
          permissions: { connections: { mail: { contract: keys.connector } } },
          steps: [send()],
          status: "send.messageId",
        },
        alias: "mail",
        answer: { messageId: "m-1" },
        status: "m-1",
      },
      {
        kind: "model",
        definition: {
          permissions: { ai: { contract: keys.model } },
          steps: [greet],
          status: "greet.line",
        },
        alias: "ai",
        answer: { line: "Hello, Ada" },
        status: "Hello, Ada",
      },
    ];
    const results = await Promise.all(
      cases.map(async ({ kind, definition, alias, answer }) => {
        const { workflow, revision } = await drafted(ada, definition);
        const run = async (fixtures: Record<string, unknown>) => {
          const { runId } = await startCandidateRun(env, ada, workflow.id, {
            revision,
            args: { who: "Ada" },
            fixtures,
          });
          return { runId, run: await ended(ada, workflow.id, runId) };
        };
        const answered = await run({ [alias]: { result: answer } });
        const unanswered = await run({});
        // An answer a real call of it would refuse, refused the same way.
        const misshapen = await run({ [alias]: { result: { wrong: 1 } } });
        return {
          kind,
          answered: endOf(answered.run),
          unanswered: endOf(unanswered.run),
          misshapen: endOf(misshapen.run),
          // Neither went out, nor was refused on its way: no call was made.
          calls: [
            ...(await callsOf(answered.runId)),
            ...(await callsOf(unanswered.runId)),
          ],
        };
      })
    );
    expect(results).toStrictEqual(
      cases.map(({ kind, status }) => ({
        kind,
        answered: { status: "completed", output: { status } },
        unanswered: { status: "failed", code: "workflow.candidate_unfixtured" },
        misshapen: { status: "failed", code: "workflow.call_invalid" },
        calls: [],
      }))
    );
  });

  it("runs with the parameters its start gives, else the defaults, never the values stored on the workflow, a sensitive one above all", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const key = await contract(admin, "connector");
    const { workflow, revision } = await drafted(
      ada,
      {
        permissions: { connections: { mail: { contract: key } } },
        params: {
          greeting: {
            label: "Greeting",
            type: { kind: "string", default: "Hello" },
            sensitive: false,
          },
          // Sensitive, so it has no default: each start gives it.
          token: { label: "Token", type: { kind: "string" } },
        },
        // The token reaches the call as a connector argument, the only place
        // a sensitive parameter may go; the greeting comes back as output.
        steps: [
          {
            id: "send",
            type: "call",
            connection: "mail",
            action: "mail.send",
            args: { to: "Ada", subject: { $expr: "params.token" } },
          },
        ],
        status: "params.greeting",
      },
      { publish: true }
    );
    const secret = `secret-${unique()}`;
    await setWorkflowParams(env, ada, workflow.id, {
      values: { greeting: "Stored", token: secret },
      expectedRevision: 0,
    });
    const run = async (params: Record<string, unknown>) => {
      const { runId } = await startCandidateRun(env, ada, workflow.id, {
        revision,
        args: { who: "Ada" },
        params,
        fixtures: { mail: { result: { messageId: "m-1" } } },
      });
      return { runId, run: await ended(ada, workflow.id, runId) };
    };
    const defaults = await run({ token: "none" });
    const given = await run({ greeting: "Given", token: "none" });
    const rows = await env.DB.prepare(
      "SELECT params FROM workflow_candidate_runs WHERE id IN (?, ?) ORDER BY created_at"
    )
      .bind(defaults.runId, given.runId)
      .all<{ params: string }>();
    const engine = await Promise.all(
      [defaults.runId, given.runId].map(
        async (id) => await runEngine(env).status(id)
      )
    );
    const kept = JSON.stringify({
      rows: rows.results,
      engine,
      events: await allEvents(),
      runs: [defaults.run, given.run],
    });
    expect({
      // Its sensitive parameter is never the stored value: not given, it
      // has none.
      untold: await outcome(
        startCandidateRun(env, ada, workflow.id, {
          revision,
          args: { who: "Ada" },
          fixtures: { mail: { result: { messageId: "m-1" } } },
        })
      ),
      defaults: endOf(defaults.run),
      given: endOf(given.run),
      frozen: rows.results.map(({ params }): unknown => JSON.parse(params)),
      secretKept: kept.includes(secret),
    }).toStrictEqual({
      untold: "workflow.params_invalid",
      defaults: { status: "completed", output: { status: "Hello" } },
      given: { status: "completed", output: { status: "Given" } },
      // What the draft's code was given: the defaults, or the start's.
      frozen: [
        { greeting: "Hello", token: "none" },
        { greeting: "Given", token: "none" },
      ],
      // Nothing of a test run, nor the audit log, ever holds it.
      secretKept: false,
    });
  });

  it("starts no run of a version, schedule or trigger, and a draft that would start one never passes to be run", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const key = await contract(admin, "connector");
    const { workflow, revision } = await drafted(ada, {
      permissions: { connections: { mail: { contract: key } } },
      steps: [send()],
      status: "send.messageId",
    });
    const { runId } = await startCandidateRun(env, ada, workflow.id, {
      revision,
      args: { who: "Ada" },
      fixtures: { mail: { result: { messageId: "Hi" } } },
    });
    const run = await ended(ada, workflow.id, runId);
    const { results: admitted } = await env.DB.prepare(
      "SELECT DISTINCT resource FROM run_lineage_attempts WHERE run_id = ?"
    )
      .bind(runId)
      .all<{ resource: string }>();
    const count = async (table: string, column: string) =>
      await countOf(
        `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`,
        workflow.id
      );
    // A draft whose step would start another run names a step no workflow
    // has: it doesn't pass, so it never runs.
    const starting = await createWorkflowResource(env, ada, `test-${unique()}`);
    const { revision: base } = await workflowDraft(env, ada, starting.id);
    const saved = await editWorkflowDraft(env, ada, starting.id, {
      revision: base,
      source: definitionOf({
        steps: [
          {
            id: "again",
            type: "start",
            workflow: workflow.id,
            input: { who: "Ada" },
          },
        ],
      }),
    });
    expect({
      end: endOf(run),
      runs: await count("workflow_resource_runs", "workflow_resource_id"),
      receipts: await count("workflow_start_receipts", "workflow_resource_id"),
      // Admitted in its workflow's test runs' own queue, never its runs'.
      admitted: admitted.map(({ resource }) => resource),
      startingChecked: saved.problems.length === 0,
      startingRun: await outcome(
        startCandidateRun(env, ada, starting.id, {
          revision: saved.revision,
          args: { who: "Ada" },
          fixtures: {},
        })
      ),
    }).toStrictEqual({
      end: { status: "completed", output: { status: "Hi" } },
      runs: 0,
      receipts: 0,
      admitted: [`candidate:${workflow.id}`],
      startingChecked: false,
      startingRun: "workflow.definition_invalid",
    });
  });

  it("runs only the draft's revision now, as it named it, once it passes, and refuses a build changed since it started", async () => {
    const ada = await person("builder");
    const { workflow, revision } = await drafted(ada, {
      steps: [hold("1 second")],
    });
    // A later revision that doesn't pass: the earlier one is no longer the
    // draft's, and the later doesn't pass, so neither runs.
    const draft = await workflowDraft(env, ada, workflow.id);
    await editWorkflowDraft(env, ada, workflow.id, {
      revision: draft.revision,
      source: "{",
    });
    const stale = await outcome(
      startCandidateRun(env, ada, workflow.id, {
        revision,
        args: { who: "Ada" },
        fixtures: {},
      })
    );
    const unchecked = await outcome(
      startCandidateRun(env, ada, workflow.id, {
        revision: revision + 1,
        args: { who: "Ada" },
        fixtures: {},
      })
    );
    // Back to a passing revision: it runs, until its sealed manifest is
    // changed under it, which its next activation refuses.
    const passing = await workflowDraft(env, ada, workflow.id);
    const saved = await editWorkflowDraft(env, ada, workflow.id, {
      revision: passing.revision,
      source: draft.source,
    });
    const { runId } = await startCandidateRun(env, ada, workflow.id, {
      revision: saved.revision,
      args: { who: "Ada" },
      fixtures: {},
    });
    const tamper = env.DB.prepare(
      "UPDATE workflow_candidate_runs SET manifest = manifest || ' ' WHERE id = ?"
    ).bind(runId);
    // Its row keeps what it pins: a change goes only around the trigger.
    const refusedTamper = await outcome(tamper.run());
    await aroundTrigger("workflow_candidate_runs_pinned", tamper);
    const changed = await ended(ada, workflow.id, runId);
    expect({
      stale,
      unchecked,
      wrongInput: await outcome(
        startCandidateRun(env, ada, workflow.id, {
          revision: saved.revision,
          args: { who: 7 },
          fixtures: {},
        })
      ),
      unknownParam: await outcome(
        startCandidateRun(env, ada, workflow.id, {
          revision: saved.revision,
          args: { who: "Ada" },
          params: { nothing: "here" },
          fixtures: {},
        })
      ),
      // A name every object inherits is no parameter either.
      inheritedParam: await outcome(
        startCandidateRun(env, ada, workflow.id, {
          revision: saved.revision,
          args: { who: "Ada" },
          params: { constructor: "here" },
          fixtures: {},
        })
      ),
      refusedTamper: refusedTamper.includes(
        "workflow_candidate_runs pin what they run"
      ),
      changed: endOf(changed),
    }).toStrictEqual({
      stale: "draft.conflict",
      unchecked: "workflow.definition_invalid",
      wrongInput: "workflow.start_invalid",
      unknownParam: "workflow.params_invalid",
      inheritedParam: "workflow.params_invalid",
      refusedTamper: true,
      changed: { status: "failed", code: "workflow.version_corrupt" },
    });
  });

  it("replays its answered call after an attempt is cut off, never asking again, and settles a start the engine never confirmed", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const key = await contract(admin, "model");
    const { workflow, revision } = await drafted(ada, {
      permissions: { ai: { contract: key } },
      steps: [greet],
      status: "greet.line",
    });
    const start = {
      revision,
      args: { who: "Ada" },
      fixtures: { ai: { result: { line: "Hi" } } },
    };
    // The output after its call is stopped once its code returned: tried
    // again, it reads the call's answer as recorded, and the call isn't
    // made again.
    const killed = await withCpuKills(
      "workflow:output",
      (attempt) => attempt === 1,
      async () => {
        const { runId } = await startCandidateRun(env, ada, workflow.id, start);
        return { runId, run: await ended(ada, workflow.id, runId) };
      },
      "end"
    );
    const attempts = await env.DB.prepare(
      "SELECT step_key AS step, attempt FROM run_lineage_attempts WHERE run_id = ? ORDER BY admitted_at"
    )
      .bind(killed.runId)
      .all<{ step: string; attempt: number }>();
    // The engine refuses everything as it is asked to take the run.
    const refused = await whileEngineRefuses(
      () => true,
      async () => await outcome(startCandidateRun(env, ada, workflow.id, start))
    );
    const { results: started } = await env.DB.prepare(
      "SELECT id FROM workflow_candidate_runs WHERE workflow_resource_id = ? ORDER BY created_at"
    )
      .bind(workflow.id)
      .all<{ id: string }>();
    const recordedEnds = await Promise.all(
      started.map(async ({ id }) => await endsOf(id))
    );
    // Both left as if the start had stopped before the engine answered:
    // a sweep a start's grace later settles them, each as the engine has it.
    await env.DB.prepare(
      "UPDATE workflow_candidate_runs SET status = 'starting', failure_code = NULL, ended_at = NULL WHERE workflow_resource_id = ?"
    )
      .bind(workflow.id)
      .run();
    await sweepCandidateRuns(env, later(11 * 60 * 1000));
    const { results: rows } = await env.DB.prepare(
      "SELECT status, failure_code AS failureCode FROM workflow_candidate_runs WHERE workflow_resource_id = ? ORDER BY created_at"
    )
      .bind(workflow.id)
      .all<{ status: string; failureCode: string | null }>();
    expect({
      killed: endOf(killed.run),
      // Each by its step's name, past the run's `<run>:do:<n>:`.
      attempts: attempts.results.map(({ step, attempt }) => [
        step.split(":").slice(3).join(":"),
        attempt,
      ]),
      refused: refused === "ok" ? "ok" : "refused",
      recordedEnds,
      rows,
    }).toStrictEqual({
      killed: { status: "completed", output: { status: "Hi" } },
      attempts: [
        ["$params", 1],
        ["greet:task", 1],
        ["workflow:output", 1],
        ["workflow:output", 2],
      ],
      refused: "refused",
      // How each ended, in the audit log as a test run's, once: the one the
      // engine never took at core's word.
      recordedEnds: [
        [
          {
            action: "workflow.run.completed",
            target: { type: "workflow_resource", id: workflow.id },
            candidate: true,
          },
        ],
        [
          {
            action: "workflow.run.failed",
            target: { type: "workflow_resource", id: workflow.id },
            candidate: true,
            failureCode: "workflow.start_unconfirmed",
          },
        ],
      ],
      rows: [
        { status: "completed", failureCode: null },
        { status: "failed", failureCode: "workflow.start_unconfirmed" },
      ],
    });
  });

  it("runs nothing more once its workflow is deleted", async () => {
    const ada = await person("builder");
    const { workflow, revision } = await drafted(ada, {
      steps: [hold("1 second")],
    });
    const { runId } = await startCandidateRun(env, ada, workflow.id, {
      revision,
      args: { who: "Ada" },
      fixtures: {},
    });
    await deleteWorkflowResource(env, ada, workflow.id);
    const row = await vi.waitFor(
      async () => {
        const found = await env.DB.prepare(
          "SELECT status FROM workflow_candidate_runs WHERE id = ?"
        )
          .bind(runId)
          .first<{ status: string }>();
        if (found?.status === "starting" || found?.status === "running") {
          throw new Error(`Test run ${runId} is ${found.status}`);
        }
        return found;
      },
      { timeout: 20_000, interval: 100 }
    );
    const engine = await runEngine(env).status(runId);
    expect({
      row,
      code: engine?.status === "errored" ? engine.error.code : engine?.status,
    }).toStrictEqual({
      row: { status: "failed" },
      code: "workflow.resource_unavailable",
    });
  });

  it("lets a person have only so many test runs going at once, each with only so many bytes of answers", async () => {
    const ada = await person("builder");
    const grace = await person("builder");
    const { workflow, revision } = await drafted(ada, {
      steps: [hold("5 seconds")],
    });
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: grace.userId,
      role: "builder",
    });
    const start = { revision, args: { who: "Ada" }, fixtures: {} };
    const going = await Promise.all(
      Array.from(
        { length: maxLiveCandidateRuns },
        async () =>
          await outcome(startCandidateRun(env, ada, workflow.id, start))
      )
    );
    expect({
      going,
      past: await outcome(startCandidateRun(env, ada, workflow.id, start)),
      // Another builder's runs are their own.
      another: await outcome(startCandidateRun(env, grace, workflow.id, start)),
      tooMuch: await outcome(
        startCandidateRun(env, grace, workflow.id, {
          ...start,
          fixtures: {
            big: { result: "x".repeat(maxCandidateFixtureBytes) },
          },
        })
      ),
    }).toStrictEqual({
      going: Array.from({ length: maxLiveCandidateRuns }, () => "ok"),
      past: "workflow.candidate_limit",
      another: "ok",
      tooMuch: "workflow.resource_invalid",
    });
  });

  it("fails a wait longer than a test run may wait, and its builder can stop one that waits", async () => {
    const ada = await person("builder");
    const { workflow: long, revision: longRevision } = await drafted(ada, {
      steps: [hold("300 days")],
    });
    const { runId: longRun } = await startCandidateRun(env, ada, long.id, {
      revision: longRevision,
      args: { who: "Ada" },
      fixtures: {},
    });
    const { workflow, revision } = await drafted(ada, {
      steps: [hold("10 minutes")],
    });
    const { runId } = await startCandidateRun(env, ada, workflow.id, {
      revision,
      args: { who: "Ada" },
      fixtures: {},
    });
    await vi.waitFor(
      async () => {
        const going = await candidateRunFor(env, ada, workflow.id, runId);
        if (going.status !== "running") {
          throw new Error(`Test run ${runId} is ${going.status}`);
        }
      },
      { timeout: 20_000, interval: 100 }
    );
    // A stop the engine refuses changes nothing, and can be asked again.
    const refusedStop = await whileEngineRefuses(
      () => true,
      async () =>
        await outcome(terminateCandidateRun(env, ada, workflow.id, runId))
    );
    const { status: afterRefused } = await candidateRunFor(
      env,
      ada,
      workflow.id,
      runId
    );
    const stopped = await terminateCandidateRun(env, ada, workflow.id, runId);
    const end = await ended(ada, workflow.id, runId);
    const again = await terminateCandidateRun(env, ada, workflow.id, runId);
    const longEnd = endOf(await ended(ada, long.id, longRun));
    const recordedEnds = {
      long: await endsOf(longRun),
      stopped: await endsOf(runId),
    };
    // Both rows left behind the engine, as if their ends never reached
    // them: the failed one still `starting`, the stopped one `running` a
    // week and more after it started. A sweep takes each as the engine has
    // it, the failure's code kept, and removes the overdue one.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE workflow_candidate_runs SET status = 'starting', failure_code = NULL, ended_at = NULL WHERE id = ?"
      ).bind(longRun),
      env.DB.prepare(
        "UPDATE workflow_candidate_runs SET status = 'running', ended_at = NULL, created_at = ? WHERE id = ?"
      ).bind(Date.now() - 8 * 24 * 60 * 60 * 1000, runId),
    ]);
    await sweepCandidateRuns(env, later(11 * 60 * 1000));
    const longRow = await env.DB.prepare(
      "SELECT status, failure_code AS failureCode FROM workflow_candidate_runs WHERE id = ?"
    )
      .bind(longRun)
      .first<{ status: string; failureCode: string | null }>();
    const events = await allEvents();
    expect({
      refusedStop: refusedStop === "ok" ? "ok" : "refused",
      afterRefused,
      long: longEnd,
      longRow,
      overdueGone: await outcome(candidateRunFor(env, ada, workflow.id, runId)),
      stopped: stopped.id,
      end: end.status,
      // Stopping one that ended changes nothing.
      again: again.status,
      recordedEnds,
      recorded: events
        .filter(
          ({ action, detail }) =>
            action === "workflow.candidate.terminated" && detail?.run === runId
        )
        .map(({ detail }) => detail?.candidate),
    }).toStrictEqual({
      refusedStop: "refused",
      afterRefused: "running",
      long: { status: "failed", code: "workflow.candidate_wait_limit" },
      longRow: {
        status: "failed",
        failureCode: "workflow.candidate_wait_limit",
      },
      overdueGone: "workflow.candidate_unavailable",
      stopped: runId,
      end: "cancelled",
      again: "cancelled",
      // How each ended, in the audit log as a test run's, once.
      recordedEnds: {
        long: [
          {
            action: "workflow.run.failed",
            target: { type: "workflow_resource", id: long.id },
            candidate: true,
            failureCode: "workflow.candidate_wait_limit",
          },
        ],
        stopped: [
          {
            action: "workflow.run.cancelled",
            target: { type: "workflow_resource", id: workflow.id },
            candidate: true,
          },
        ],
      },
      recorded: [true],
    });
  });

  it("fails a test run that goes on past its lifetime, however its waits are chained", async () => {
    const ada = await person("builder");
    const { workflow, revision } = await drafted(ada, {
      steps: [hold("1 second", "first"), hold("1 second", "second")],
    });
    const { runId } = await startCandidateRun(env, ada, workflow.id, {
      revision,
      args: { who: "Ada" },
      fixtures: {},
    });
    // Started longer ago than a test run may go on, as if its waits had
    // been chained that long: its next activation ends it.
    await env.DB.prepare(
      "UPDATE workflow_candidate_runs SET created_at = ? WHERE id = ?"
    )
      .bind(Date.now() - maxCandidateLifetimeMs - 60_000, runId)
      .run();
    expect(endOf(await ended(ada, workflow.id, runId))).toStrictEqual({
      status: "failed",
      code: "workflow.candidate_time_limit",
    });
  });

  it("keeps only so many test runs of a person's, refusing more until the sweep takes old ones, and ends overdue ones the engine lost", async () => {
    const ada = await person("builder");
    const { workflow, revision } = await drafted(ada, {
      steps: [],
    });
    const start = { revision, args: { who: "Ada" }, fixtures: {} };
    const { runId } = await startCandidateRun(env, ada, workflow.id, start);
    await ended(ada, workflow.id, runId);
    // The rest of what a person may keep, as if started and ended a week
    // and more ago; one of them still `running`, with no run in the engine.
    const weekAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const kept = Array.from(
      { length: maxKeptCandidateRuns - 1 },
      (_, index) => ({
        id: crypto.randomUUID(),
        status: index === 0 ? "running" : "completed",
      })
    );
    await env.DB.batch(
      kept.map(({ id, status }) =>
        env.DB.prepare(
          "INSERT INTO workflow_candidate_runs (id, workflow_resource_id, draft_revision, manifest, manifest_hash, build_hash, reservation, principal_id, input, params, fixtures, status, created_at, ended_at) SELECT ?, workflow_resource_id, draft_revision, manifest, manifest_hash, build_hash, ?, principal_id, input, params, fixtures, ?, ?, ? FROM workflow_candidate_runs WHERE id = ?"
        ).bind(
          id,
          `${workflow.id}~candidate~${id}`,
          status,
          weekAgo,
          status === "running" ? null : weekAgo,
          runId
        )
      )
    );
    const full = await outcome(startCandidateRun(env, ada, workflow.id, start));
    await sweepCandidateRuns(env);
    const lost = kept[0]?.id ?? "";
    expect({
      full,
      lostEnd: await endsOf(lost),
      lostGone: await outcome(candidateRunFor(env, ada, workflow.id, lost)),
      remaining: await countOf(
        "SELECT COUNT(*) AS n FROM workflow_candidate_runs WHERE workflow_resource_id = ?",
        workflow.id
      ),
      afterSweep: await outcome(
        startCandidateRun(env, ada, workflow.id, start)
      ),
    }).toStrictEqual({
      full: "workflow.candidate_kept_limit",
      lostEnd: [
        {
          action: "workflow.run.failed",
          target: { type: "workflow_resource", id: workflow.id },
          candidate: true,
          failureCode: "workflow.run_unavailable",
        },
      ],
      // Ended failed, as the engine had no record of it, then taken.
      lostGone: "workflow.candidate_unavailable",
      // Only the run of this week is left.
      remaining: 1,
      afterSweep: "ok",
    });
  });

  it("is started, read and stopped only by the workflow's builders, never its users, others or Grasp staff", async () => {
    const ada = await person("builder");
    const user = await person("builder");
    const other = await person("builder");
    const staff = await person("admin", true);
    const { workflow, revision } = await drafted(ada, {
      steps: [],
    });
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const start = { revision, args: { who: "Ada" }, fixtures: {} };
    const { runId } = await startCandidateRun(env, ada, workflow.id, start);
    await ended(ada, workflow.id, runId);
    const starts = await Promise.all(
      [user, other, staff].map(
        async (by) =>
          await outcome(startCandidateRun(env, by, workflow.id, start))
      )
    );
    const reads = await Promise.all(
      [user, other, staff].map(
        async (by) =>
          await outcome(candidateRunFor(env, by, workflow.id, runId))
      )
    );
    const stops = await Promise.all(
      [user, other, staff].map(
        async (by) =>
          await outcome(terminateCandidateRun(env, by, workflow.id, runId))
      )
    );
    // Another of Ada's workflows never answers for this one's test run.
    const { workflow: elsewhere } = await drafted(ada, {
      steps: [],
    });
    expect({
      starts,
      reads,
      stops,
      elsewhere: await outcome(candidateRunFor(env, ada, elsewhere.id, runId)),
    }).toStrictEqual({
      // Its user sees the workflow, but builds nothing of it; anyone else
      // doesn't see it; staff never start, read or stop one.
      starts: [
        "role.forbidden",
        "workflow.resource_unavailable",
        "role.forbidden",
      ],
      reads: [
        "role.forbidden",
        "workflow.resource_unavailable",
        "role.forbidden",
      ],
      stops: [
        "role.forbidden",
        "workflow.resource_unavailable",
        "role.forbidden",
      ],
      elsewhere: "workflow.candidate_unavailable",
    });
  });

  it("is kept only for a week, then goes with its engine record and its build's references", async () => {
    const ada = await person("builder");
    const { workflow, revision } = await drafted(ada, {
      steps: [],
    });
    const { runId } = await startCandidateRun(env, ada, workflow.id, {
      revision,
      args: { who: "Ada" },
      fixtures: {},
    });
    await ended(ada, workflow.id, runId);
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const seal = await env.DB.prepare(
      "SELECT reservation FROM workflow_candidate_runs WHERE id = ?"
    )
      .bind(runId)
      .first<{ reservation: string }>();
    const references = async () =>
      await countOf(
        "SELECT COUNT(*) AS n FROM sdk_artifact_refs WHERE seal = ?",
        seal?.reservation ?? ""
      );
    // A week less a minute: kept, and so are its build's references, past
    // the release sweep's.
    await sweepCandidateRuns(env, later(weekMs - 60_000));
    await sweepReleases(env, later(weekMs - 60_000));
    const keptEarly = await outcome(
      candidateRunFor(env, ada, workflow.id, runId)
    );
    const reservedEarly = await references();
    await sweepCandidateRuns(env, later(weekMs + 60_000));
    expect({
      keptEarly,
      reservedEarly: reservedEarly > 0,
      afterWeek: await outcome(candidateRunFor(env, ada, workflow.id, runId)),
      engine: await runEngine(env).status(runId),
      reservedAfter: await references(),
    }).toStrictEqual({
      keptEarly: "ok",
      reservedEarly: true,
      afterWeek: "workflow.candidate_unavailable",
      engine: undefined,
      reservedAfter: 0,
    });
  });
});

describe("a draft's test run and what its workflow keeps between runs", () => {
  it("freezes the state with its row as it starts, whatever is written since, and runs with it", async () => {
    const ada = await person("builder");
    const { workflow, revision } = await drafted(ada, { status: '"done"' });
    // A run of the workflow's, as core keeps it, that keeps state.
    const live = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO workflow_start_receipts (id, invoker_type, invoker_id, idempotency_key, workflow_resource_id, workflow_resource_version, manifest_hash, principal_id, authority_generation, input_hash, created_at) VALUES (?, 'person', ?, ?, ?, 1, 'manifest', ?, 0, 'input', ?)"
      ).bind(live, ada.userId, unique(), workflow.id, ada.userId, Date.now()),
      env.DB.prepare(
        "INSERT INTO workflow_resource_runs (id, workflow_resource_id, version, manifest_hash, build_hash, principal_id, status, created_at) VALUES (?, ?, 1, 'manifest', 'build', ?, 'running', ?)"
      ).bind(live, workflow.id, ada.userId, Date.now()),
    ]);
    await writeWorkflowState(env, live, stepIdempotencyKey(live, "a:task"), {
      count: 1,
    });
    const { runId } = await startCandidateRun(env, ada, workflow.id, {
      revision,
      args: { who: "Ada" },
      fixtures: {},
    });
    await writeWorkflowState(env, live, stepIdempotencyKey(live, "b:task"), {
      count: 2,
    });
    const end = endOf(await ended(ada, workflow.id, runId));
    const frozen = await env.DB.prepare(
      "SELECT snapshot.body AS state FROM workflow_candidate_runs AS run JOIN workflow_state_snapshots AS snapshot ON snapshot.hash = run.state_hash WHERE run.id = ?"
    )
      .bind(runId)
      .first<{ state: string }>();
    expect({
      end,
      frozen: frozen?.state,
      now: await workflowStateOf(env, workflow.id),
    }).toStrictEqual({
      end: { status: "completed", output: { status: "done" } },
      frozen: '{"count":1}',
      now: { count: 2 },
    });
  });
});

/**
 * A connector contract reading attachments as files and sending with run
 * files, as a native connector's confirmed operations record it
 * (`answersFile`, `takesFiles`): stored as such under a key of its own,
 * as only a contract compared with what a connection serves is.
 */
const filingContract = async (admin: Identity): Promise<string> => {
  const key = `filing-${unique()}`;
  const contractOf = {
    kind: "connector",
    operations: {
      "mail.readAttachment": {
        input: descriptor({ message: "string" }),
        output: descriptor({
          name: "string",
          contentType: "string",
          encoding: "string",
          content: "string",
        }),
        readOnly: true,
        answersFile: true,
      },
      "mail.send": {
        input: JSON.stringify(
          v.object({
            to: v.string(),
            attachments: v.array(v.object({ file: v.string() })),
          }).descriptor
        ),
        output: descriptor({ messageId: "string" }),
        takesFiles: true,
      },
    },
  };
  const text = canonicalJson(z.json().parse(contractOf));
  await env.DB.prepare(
    "INSERT INTO workflow_catalog_contracts (key, kind, contract, fingerprint, published_by, published_at) VALUES (?, 'connector', ?, ?, ?, ?)"
  )
    .bind(key, text, await sha256Hex(text), admin.userId, Date.now())
    .run();
  return key;
};

/** A CSV attachment's name and label, as a read answers them. */
const invoiceFile = { name: "invoice.csv", contentType: "text/csv" };

describe("a draft's test run keeping and attaching run files", () => {
  it("answers a read kept as a file with a stand-in reference, checked as a real read is, attaches, reads and deletes it by its ID, and keeps nothing", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const filing = await filingContract(admin);
    const files = await contract(admin, "files");
    const { workflow, revision } = await drafted(ada, {
      permissions: {
        connections: {
          reader: { contract: filing },
          mailer: { contract: filing },
        },
        files: { runFiles: { contract: files } },
      },
      steps: [
        {
          id: "kept",
          type: "call",
          connection: "reader",
          action: "mail.readAttachment",
          args: { message: "m1" },
          into: "runFiles",
        },
        {
          id: "sent",
          type: "call",
          connection: "mailer",
          action: "mail.send",
          args: {
            to: { $expr: "args.who" },
            attachments: [{ file: { $expr: "kept.file.file" } }],
          },
          from: "runFiles",
        },
        // Read back and deleted by its ID, as a real run's kept file is.
        {
          id: "text",
          type: "call",
          files: "runFiles",
          action: "read",
          args: { file: { $expr: "kept.file.file" } },
        },
        {
          id: "removed",
          type: "call",
          files: "runFiles",
          action: "delete",
          args: { file: { $expr: "kept.file.file" } },
        },
      ],
      status:
        '(kept.file.file.length === 36 ? "id" : "no id") + " " + kept.file.name + " " + kept.file.size + " " + sent.messageId + " " + text.text',
    });
    const csv = "a,b\n1,2\n";
    const run = async (
      content: string,
      file: { name: string; contentType: string } = invoiceFile
    ) => {
      const { runId } = await startCandidateRun(env, ada, workflow.id, {
        revision,
        args: { who: "Ada" },
        fixtures: {
          reader: {
            result: { ...file, encoding: "base64", content },
          },
          mailer: { result: { messageId: "m-1" } },
          runFiles: { result: { text: "a,b" } },
        },
      });
      const calls = await callsOf(runId);
      return {
        end: endOf(await ended(ada, workflow.id, runId)),
        calls: calls.length,
        files: await countOf(
          "SELECT count(*) AS n FROM workflow_run_files WHERE run_id = ?",
          runId
        ),
      };
    };
    const kept = await run(btoa(csv));
    // A fixture that isn't a file's content fails as a real read would.
    const { end: notBase64 } = await run("not base64!");
    // Typed by its bytes and named as a real read's file is: a PDF
    // labelled text is a PDF, and a name no run file may have is replaced.
    const pdf = "%PDF-1.7\n";
    const { end: relabelled } = await run(btoa(pdf), {
      name: "../../etc/scan.pdf",
      contentType: "text/plain",
    });
    // A ZIP labelled a Word document declares nothing: no run file's type.
    const { end: unsupported } = await run(
      btoa(String.fromCodePoint(0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4)),
      {
        name: "letter.docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }
    );
    expect({ kept, notBase64, relabelled, unsupported }).toStrictEqual({
      kept: {
        end: {
          status: "completed",
          output: { status: `id invoice.csv ${csv.length} m-1 a,b` },
        },
        calls: 0,
        files: 0,
      },
      notBase64: { status: "failed", code: "workflow.call_invalid" },
      relabelled: {
        status: "completed",
        output: { status: `id attachment ${pdf.length} m-1 a,b` },
      },
      unsupported: { status: "failed", code: "file.run_type_unsupported" },
    });
  });
});
