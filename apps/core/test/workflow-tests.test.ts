import { v } from "@grasp-os/runtime/app";
import { declaredWorkflows } from "@grasp-os/runtime/host";
import { expectedMessageOf, isExpectedError } from "@grasp-os/shared/errors";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { fixtureHostFor, sweepTestFixtures } from "../src/app-tests.ts";
import { appKind, findApp, releaseIdsOf } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { rollback } from "../src/publish.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { setWorkflowParams } from "../src/workflow-params.ts";
import { createWorkflowResource } from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { runEngine, runObjectOf } from "../src/workflows/engine.ts";
import { boundIn, testApp } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { passing } from "./json-workflow-apps.ts";
import { fakeProvider } from "./model-provider.ts";
import { liveStatus, sleeping, statusOnce } from "./runs.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import { auditedDuring, unique } from "./sign-in.ts";
import { connectDb } from "./test-env.ts";
import { publishDefinition } from "./workflow-publishing.ts";

// Workflow runs in an App's tests (`appTest`, spec 28.2): a test identity
// starts a workflow the release under test binds, and the run is real, on
// the engine, the same version as anyone's, but nothing of the
// organization's. The threat model is in workflows/fixture-runs.ts; the
// ways it can fail come first here: a test's run lands in the
// organization's runs, receipts or audit; it reaches a model or a
// connection (its model calls are workflow-test-calls.test.ts's);
// it outlives its test, or a test died before removing it; a test asks
// about a run it didn't start; a test starts what the release doesn't
// bind. Then what a test sees: the run's end, how often each task
// completed, and its time moved on by the test's clock (`t.clock`).

/** An object of `fields`, each required. */
const objectSchema = (fields: Record<string, unknown>) => ({
  kind: "object",
  fields,
});

/** What a greeting ends with: `{ status: "Hello, <who>" }`. */
const greetingStatus = { $expr: '"Hello, " + args.who' };

/**
 * A grasp-workflow/2 workflow of `steps`, its args `who` and its result
 * `status` (a greeting unless said), with `permissions` and `params`.
 */
const definitionOf = (
  steps: unknown[],
  {
    permissions = {},
    params = {},
    status = greetingStatus,
  }: {
    permissions?: Record<string, unknown>;
    params?: Record<string, unknown>;
    status?: unknown;
  } = {}
): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ who: { kind: "string" } }),
    returns: objectSchema({ status: { kind: "string" } }),
    result: { status },
    params,
    permissions,
    steps,
  });

/** Greets its input's `who` in step `greet`, after `before`. */
const greeting = (before: unknown[] = []) => [...before, passing("greet")];

/** A wait of `duration` (`"1 hour"`) in step `hold`. */
const hold = (duration: string) => ({
  id: "hold",
  type: "wait",
  for: duration,
});

/** The App's files: it binds `followUp`, with `tests` as its tests. */
const filesWith = (tests: Record<string, string> = {}): TestApp =>
  testApp(
    {
      name: "Requests",
      tables: {
        requests: {
          fields: { who: "v.string()" },
          access: { read: "appMembers", write: "appMembers" },
        },
      },
      permissions: [
        'permission.workflow("followUp", {\n  args: v.object({ who: v.string().trim().min(1) }),\n  returns: v.object({ status: v.string() }),\n})',
      ],
    },
    {
      "server/requests.ts": `import { v } from "@grasp-os/sdk";
import { permissions } from "../grasp.config.ts";

export const followUp = permissions.followUp;
`,

      ...tests,
    }
  );

/** A connector contract of the catalog `admin` publishes: `mail.send`. */
const mailContract = async (admin: Identity): Promise<string> => {
  const key = `mail-${unique()}`;
  await publishCatalogContract(env, admin, {
    key,
    kind: "connector",
    operations: {
      "mail.send": {
        input: JSON.stringify(
          v.object({ to: v.string(), subject: v.string() }).descriptor
        ),
        output: JSON.stringify(v.object({ messageId: v.string() }).descriptor),
      },
    },
  });
  return key;
};

/** A workflow of `by`'s, its version 1 `steps`. */
const workflowOf = async (
  by: Acting,
  steps: unknown[],
  shape: Parameters<typeof definitionOf>[1] = {}
): Promise<string> => {
  const workflow = await createWorkflowResource(env, by, `greet-${unique()}`);
  await publishDefinition(env, by, workflow.id, definitionOf(steps, shape));
  return workflow.id;
};

/** The Requests App with `tests`, binding workflow `workflow` as `followUp`. */
const requestsApp = async (
  workflow: (by: Acting) => Promise<string>,
  tests: Record<string, string> = {}
) => {
  const builder = await person("builder");
  const workflowId = await workflow(builder);
  const fixture = await appWith(
    boundIn(filesWith(tests), { followUp: workflowId }),
    "Requests",
    builder
  );
  await seal(fixture);
  const release = await loadRelease(env, fixture.app, 1);
  return { builder, app: fixture.app, workflowId, release };
};

/** A start of `followUp` with `args`, as the SDK sends it. */
const startOf = async (
  release: Release,
  args: unknown,
  change: (reference: Record<string, unknown>) => void = () => {
    // As generated.
  }
): Promise<string> => {
  const declared = declaredWorkflows(release.app, release.workflows).find(
    ({ alias }) => alias === "followUp"
  );
  if (declared === undefined) {
    throw new Error("No followUp");
  }
  const reference: Record<string, unknown> = {
    name: "workflows.followUp.mutations.start",
    kind: "mutation",
  };
  change(reference);
  return await Promise.resolve(JSON.stringify({ reference, args: { args } }));
};

const resultSchema = z.union([
  z.object({ ok: z.literal(true), value: z.object({ run: z.number() }) }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
]);

/** What a session's start answered: the run's number, or the refusal's code. */
const startedAs = (answer: string): number | string => {
  const result = resultSchema.parse(JSON.parse(answer));
  return result.ok ? result.value.run : result.error.code;
};

/**
 * A test session on the Requests App's release, on `on`, with
 * `desk-user` as someone it acts as: each start with `options` as its
 * test gives a start's (`TestStartOptions`), none unless said.
 */
const sessionOf = async (
  release: Release,
  {
    options = {},
    on = env,
  }: {
    options?: Record<string, unknown>;
    on?: Env;
  } = {}
) => {
  const host = fixtureHostFor(on, release, await releaseIdsOf(on, release));
  const session = await host.open(`test-${unique()}`);
  const refused = await session.identify(
    JSON.stringify({ name: "desk-user", role: "user", teams: [] })
  );
  if (refused !== undefined) {
    throw new Error(refused);
  }
  const given = JSON.stringify(options);
  const start = session.start.bind(session);
  // Its starts, with the options a test's `identity.start` sends.
  return Object.assign(session, {
    start: async (name: unknown, request: unknown): Promise<string> =>
      await start(name, request, given),
  });
};

/** How run `run` of `session` ended, as the test is told. */
const endOf = async (
  session: Awaited<ReturnType<typeof sessionOf>>,
  run: number | string
): Promise<unknown> => JSON.parse(await session.runOutcome(run));

/** The test runs core still records for `app`. */
const recordedRuns = async (app: string): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    "SELECT run_id AS id FROM app_test_runs WHERE app_id = ?"
  )
    .bind(app)
    .all<{ id: string }>();
  return results.map(({ id }) => id);
};

/** The organization's receipts and runs of `workflow`. */
const organizationRunsOf = async (workflow: string) => {
  const receipts = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM workflow_start_receipts WHERE workflow_resource_id = ?"
  )
    .bind(workflow)
    .first<{ n: number }>();
  const runs = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM workflow_resource_runs WHERE workflow_resource_id = ?"
  )
    .bind(workflow)
    .first<{ n: number }>();
  return { receipts: receipts?.n, runs: runs?.n };
};

/** Activates version 1: whether it was made current, or the refusal's failures. */
const activated = async (
  by: Acting & Identity,
  app: string
): Promise<unknown> => {
  try {
    await rollback(env, appKind, by, app, 1);
  } catch (error) {
    if (!isExpectedError(error)) {
      throw error;
    }
    return error.details?.failures ?? error.code;
  }
  const found = await findApp(env, app);
  return found.currentVersion === 1 ? "current" : found.currentVersion;
};

/** The calls connect has a record of, whoever made them. */
const connectCalls = async (): Promise<number> => {
  const row = await connectDb()
    .prepare("SELECT COUNT(*) AS n FROM idempotent_calls")
    .first<{ n: number }>();
  return row?.n ?? -1;
};

/** Whether `work` answered or was refused. */
const refusal = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
    return "answered";
  } catch (error) {
    return error instanceof Error ? "refused" : "thrown";
  }
};

/** A suite of one test of the App's workflow, `body` with `owner` at hand. */
const suiteOf = (
  body: string
): string => `import { appTest } from "@grasp-os/sdk/testing";
import { ${["api", "workflows"].filter((name) => body.includes(`${name}.`)).join(", ")} } from "@server/_generated/api";
${body.includes("expect(") ? 'import { expect } from "vitest";\n' : ""}import schema from "../server/schema.ts";

export default appTest(schema, {
  "runs": async (t) => {
${body.includes("owner") ? '    const owner = t.withIdentity({ name: "desk-user" });' : ""}
    ${body}
  },
});
`;

describe("an App's workflow tests", { timeout: 180_000 }, () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("run the workflow the release binds on the engine, to its end, each task completed once, and leave nothing of the organization's", async () => {
    const { builder, app, workflowId } = await requestsApp(
      async (by) => await workflowOf(by, greeting([hold("1 second")])),
      {
        "tests/greet.test.ts": suiteOf(`
      const run = await owner.start(workflows.followUp, { who: "Ada" });
      expect(await t.runs.untilTerminal(run)).toEqual({
        status: "completed",
        result: { status: "Hello, Ada" },
      });
      expect(await t.effects.completedCount(run, "greet")).toBe(1);
      expect(await t.effects.completedCount(run, "hold")).toBe(1);
      expect(await t.effects.completedCount(run, "elsewhere")).toBe(0);`),
      }
    );
    let outcome: unknown;
    const events = await auditedDuring(async () => {
      outcome = await activated(builder, app);
    });
    expect({
      outcome,
      organization: await organizationRunsOf(workflowId),
      recorded: await recordedRuns(app),
      // The run's own: never the binding the version makes as it goes live.
      runEvents: events.filter(
        ({ action }) =>
          action.startsWith("workflow.") &&
          !action.startsWith("workflow.app_binding.")
      ),
    }).toStrictEqual({
      outcome: "current",
      organization: { receipts: 0, runs: 0 },
      recorded: [],
      runEvents: [],
    });
  });

  it("refuse a version whose workflow test fails, saying how the run ended", async () => {
    const { builder, app } = await requestsApp(
      async (by) =>
        await workflowOf(by, [
          {
            id: "greet",
            type: "raise",
            error: { code: "test.greet", message: "Failed." },
          },
        ]),
      {
        "tests/greet.test.ts": suiteOf(`
      const run = await owner.start(workflows.followUp, { who: "Ada" });
      const ended = await t.runs.untilTerminal(run);
      expect(ended.status, "the run").toBe("completed");`),
      }
    );
    await expect(activated(builder, app)).resolves.toStrictEqual([
      "tests/greet.test.ts, \"runs\": the run: expected 'failed' to be 'completed' // Object.is equality",
    ]);
  });

  it("refuse a start of what the release doesn't bind, or with args it doesn't take", async () => {
    const { release, app } = await requestsApp(
      async (by) => await workflowOf(by, greeting())
    );
    const session = await sessionOf(release);
    const refused = {
      alias: startedAs(
        await session.start(
          "desk-user",
          await startOf(release, { who: "Ada" }, (reference) => {
            reference.name = "workflows.elsewhere.mutations.start";
          })
        )
      ),
      control: startedAs(
        await session.start(
          "desk-user",
          await startOf(release, { who: "Ada" }, (reference) => {
            reference.name = "workflows.followUp.mutations.cancel";
          })
        )
      ),
      query: startedAs(
        await session.start(
          "desk-user",
          await startOf(release, { who: "Ada" }, (reference) => {
            reference.kind = "query";
          })
        )
      ),
      input: startedAs(
        await session.start("desk-user", await startOf(release, { who: "" }))
      ),
      notAStart: startedAs(
        await session.start(
          "desk-user",
          JSON.stringify({ reference: {}, args: {} })
        )
      ),
    };
    await session.close();
    expect({ refused, recorded: await recordedRuns(app) }).toStrictEqual({
      refused: {
        alias: "function.not_found",
        control: "contract.invalid_request",
        query: "contract.invalid_request",
        input: "contract.invalid_args",
        notAStart: "contract.invalid_request",
      },
      recorded: [],
    });
  });

  it("fail a model call its fixture gives no answer: a model is never asked", async () => {
    const admin = await person("admin");
    const key = `summary-${unique()}`;
    await publishCatalogContract(env, admin, { key, kind: "model" });
    const { release } = await requestsApp(
      async (by) =>
        await workflowOf(
          by,
          [
            {
              id: "greet",
              type: "generate",
              instructions: "Greet them.",
              input: { who: { $expr: "args.who" } },
              returns: objectSchema({ line: { kind: "string" } }),
            },
          ],
          {
            permissions: { ai: { contract: key } },
            status: { $expr: "greet.line" },
          }
        )
    );
    const provider = await fakeProvider({
      text: '{"line":"Hello"}',
      inputTokens: 1,
      outputTokens: 1,
    });
    const session = await sessionOf(release);
    const run = startedAs(
      await session.start("desk-user", await startOf(release, { who: "Ada" }))
    );
    const ended: unknown = JSON.parse(await session.runOutcome(run));
    const completed = await session.completedCount(run, "greet");
    await session.close();
    expect({ ended, completed, asked: provider.requests.length }).toMatchObject(
      {
        ended: { status: "failed", code: "workflow.test_unfixtured" },
        completed: 0,
        asked: 0,
      }
    );
  });

  it("answer only about the runs their own test started", async () => {
    const { release } = await requestsApp(
      async (by) => await workflowOf(by, greeting())
    );
    const mine = await sessionOf(release);
    const theirs = await sessionOf(release);
    const run = startedAs(
      await mine.start("desk-user", await startOf(release, { who: "Ada" }))
    );
    const asked = {
      otherSession: await refusal(async () => await theirs.runOutcome(run)),
      notStarted: await refusal(async () => await mine.runOutcome(7)),
      notANumber: await refusal(
        async () => await mine.completedCount("0", "greet")
      ),
      otherPrincipal: startedAs(
        await mine
          .start("stranger", await startOf(release, { who: "Ada" }))
          .catch(() =>
            JSON.stringify({ ok: false, error: { code: "refused" } })
          )
      ),
    };
    await mine.close();
    await theirs.close();
    expect({ run, asked }).toStrictEqual({
      run: 0,
      asked: {
        otherSession: "refused",
        notStarted: "refused",
        notANumber: "refused",
        otherPrincipal: "refused",
      },
    });
  });

  it("refuse a run another test started, though its number names one of this test's own", async () => {
    const { builder, app } = await requestsApp(
      async (by) => await workflowOf(by, greeting()),
      {
        "tests/greet.test.ts": `import { appTest } from "@grasp-os/sdk/testing";
import type { WorkflowTestRun } from "@grasp-os/sdk/testing";
import { workflows } from "@server/_generated/api";
import { expect } from "vitest";
import schema from "../server/schema.ts";

let kept: WorkflowTestRun | undefined;

const askedOf = async (ask: () => Promise<unknown>): Promise<string> => {
  try {
    await ask();
    return "answered";
  } catch (error) {
    return error instanceof Error ? error.message : "thrown";
  }
};

export default appTest(schema, {
  "first": async (t) => {
    const owner = t.withIdentity({ name: "desk-user" });
    const run = await owner.start(workflows.followUp, { who: "Ada" });
    kept = run;
    expect((await t.runs.untilTerminal(run)).status).toBe("completed");
  },
  "second": async (t) => {
    const theirs = kept;
    if (theirs === undefined) {
      throw new Error("the first test kept no run");
    }
    const owner = t.withIdentity({ name: "desk-user" });
    const own = await owner.start(workflows.followUp, { who: "Bob" });
    expect((await t.runs.untilTerminal(own)).status).toBe("completed");
    expect([
      await askedOf(async () => await t.runs.untilTerminal(theirs)),
      await askedOf(async () => await t.effects.completedCount(theirs, "greet")),
    ]).toEqual([
      "expected a run this test started, not one another test started",
      "expected a run this test started, not one another test started",
    ]);
  },
});
`,
      }
    );
    await expect(activated(builder, app)).resolves.toBe("current");
  });

  it("start at most ten runs in one test, however many it asks for at once", async () => {
    const { release, app } = await requestsApp(
      async (by) => await workflowOf(by, greeting([hold("1 hour")]))
    );
    const session = await sessionOf(release);
    const request = await startOf(release, { who: "Ada" });
    const answers = await Promise.all(
      Array.from(
        { length: 12 },
        async () => await session.start("desk-user", request)
      )
    );
    const started = answers.map(startedAs);
    const recorded = await recordedRuns(app);
    await session.close();
    expect({
      runs: started.filter((answer) => typeof answer === "number").length,
      refused: started.filter((answer) => typeof answer === "string"),
      recorded: recorded.length,
      left: await recordedRuns(app),
    }).toStrictEqual({
      runs: 10,
      refused: ["function.call_limit", "function.call_limit"],
      recorded: 10,
      left: [],
    });
  });

  it("remove a test's runs from the engine as it ends, ended or not, and the sweep those a dead test left", async () => {
    const { release, app } = await requestsApp(
      async (by) => await workflowOf(by, greeting([hold("1 hour")]))
    );
    const ended = await sessionOf(release);
    startedAs(
      await ended.start("desk-user", await startOf(release, { who: "Ada" }))
    );
    const [closed] = await recordedRuns(app);
    await ended.close();

    // A test that died: its session never closed. Its time is up.
    const dead = await sessionOf(release);
    startedAs(
      await dead.start("desk-user", await startOf(release, { who: "Bo" }))
    );
    const [left = ""] = await recordedRuns(app);
    const before = await runEngine(env).status(left);
    await env.DB.prepare(
      "UPDATE app_test_runs SET deadline = ? WHERE run_id = ?"
    )
      .bind(Date.now() - 1000, left)
      .run();
    // One whose test still runs: kept, whenever it started.
    const live = await sessionOf(release);
    startedAs(
      await live.start("desk-user", await startOf(release, { who: "Cy" }))
    );
    const both = await recordedRuns(app);
    const running = both.find((id) => id !== left) ?? "";
    await env.DB.prepare(
      "UPDATE app_test_runs SET created_at = ? WHERE run_id = ?"
    )
      .bind(Date.now() - 2 * 60 * 60_000, running)
      .run();
    await sweepTestFixtures(env, new Date());
    const kept = await recordedRuns(app);
    await live.close();
    expect({
      closed: await runEngine(env).status(closed ?? ""),
      before: before !== undefined,
      swept: await runEngine(env).status(left),
      kept,
      recorded: await recordedRuns(app),
    }).toStrictEqual({
      closed: undefined,
      before: true,
      swept: undefined,
      kept: [running],
      recorded: [],
    });
  });

  it("sweep the runs left longest ago first, a page at a time", async () => {
    const app = `app_${unique()}`;
    const now = Date.now();
    // Recorded oldest last, its deadline the latest: only the order by when
    // each was recorded puts it first.
    const rows = Array.from({ length: 51 }, (_, index) => ({
      runId: `left-${unique()}-${index}`,
      createdAt: now - 60_000 * (index + 1),
      deadline: now - 1000 * (51 - index),
    }));
    await env.DB.batch(
      rows.map(({ runId, createdAt, deadline }) =>
        env.DB.prepare(
          "INSERT INTO app_test_runs (run_id, app_id, app_version, workflow_resource_id, version, manifest_hash, build_hash, principal, input, params, created_at, deadline) VALUES (?, ?, 1, 'wf', 1, ?, ?, 'fixture-desk-user', '{}', '{}', ?, ?)"
        ).bind(runId, app, "0".repeat(64), "0".repeat(64), createdAt, deadline)
      )
    );
    await sweepTestFixtures(env, new Date());
    await expect(recordedRuns(app)).resolves.toStrictEqual([rows[0]?.runId]);
  });

  it("keep a run's record for the next sweep when it can't be deleted, and sweep on", async () => {
    const app = `app_${unique()}`;
    const runId = `left-${unique()}`;
    await env.DB.prepare(
      "INSERT INTO app_test_runs (run_id, app_id, app_version, workflow_resource_id, version, manifest_hash, build_hash, principal, input, params, created_at, deadline) VALUES (?, ?, 1, 'wf', 1, ?, ?, 'fixture-desk-user', '{}', '{}', ?, ?)"
    )
      .bind(
        runId,
        app,
        "0".repeat(64),
        "0".repeat(64),
        Date.now(),
        Date.now() - 1000
      )
      .run();
    // D1 refuses the record's delete, and only that.
    const db = new Proxy(env.DB, {
      get: (target, name): unknown => {
        const value: unknown = Reflect.get(target, name);
        if (name === "prepare" && typeof value === "function") {
          return (query: string): unknown => {
            if (/delete from "app_test_runs"/iu.test(query)) {
              throw new Error("D1 is unavailable.");
            }
            return Reflect.apply(value, target, [query]);
          };
        }
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
    const swept = await refusal(async () => {
      await sweepTestFixtures({ ...env, DB: db }, new Date());
    });
    expect({ swept, kept: await recordedRuns(app) }).toStrictEqual({
      swept: "answered",
      kept: [runId],
    });
  });

  it("stop an activation once its test's time is up", async () => {
    const { release } = await requestsApp(
      async (by) => await workflowOf(by, greeting([hold("2 seconds")]))
    );
    const session = await sessionOf(release);
    const run = startedAs(
      await session.start("desk-user", await startOf(release, { who: "Ada" }))
    );
    await env.DB.prepare("UPDATE app_test_runs SET deadline = ?")
      .bind(Date.now() - 1000)
      .run();
    const ended = await endOf(session, run);
    await session.close();
    expect(ended).toMatchObject({
      status: "failed",
      code: "function.cancelled",
    });
  });

  it("stop waiting for a run's end once its test's session closes", async () => {
    const { release } = await requestsApp(
      async (by) => await workflowOf(by, greeting([hold("1 hour")]))
    );
    const session = await sessionOf(release);
    const run = startedAs(
      await session.start("desk-user", await startOf(release, { who: "Ada" }))
    );
    const waiting = session.runOutcome(run);
    await scheduler.wait(200);
    await session.close();
    const answered = await Promise.race([
      waiting,
      (async () => {
        await scheduler.wait(5000);
        return "still waiting";
      })(),
    ]);
    expect(answered).toBe("null");
  });

  it("keep a start's room once it was recorded, and remove its run, when the engine fails it", async () => {
    const { release, app } = await requestsApp(
      async (by) => await workflowOf(by, greeting([hold("1 hour")]))
    );
    let failed = false;
    const failingStart = <T extends object>(namespace: T): T =>
      new Proxy(namespace, {
        get: (target, name): unknown => {
          const value: unknown = Reflect.get(target, name);
          if (name === "jurisdiction" && typeof value === "function") {
            return (...args: unknown[]): unknown => {
              const scoped: unknown = Reflect.apply(value, target, args);
              return typeof scoped === "object" && scoped !== null
                ? failingStart(scoped)
                : scoped;
            };
          }
          if (name === "get" && typeof value === "function") {
            return (...args: unknown[]): unknown => {
              const stub: unknown = Reflect.apply(value, target, args);
              if (typeof stub !== "object" || stub === null) {
                return stub;
              }
              return new Proxy(stub, {
                get: (object, method): unknown => {
                  const member: unknown = Reflect.get(object, method);
                  if (method === "start" && !failed) {
                    failed = true;
                    return async () => {
                      await Promise.resolve();
                      throw new Error("The engine couldn't be reached.");
                    };
                  }
                  return typeof member === "function"
                    ? (...called: unknown[]): unknown =>
                        Reflect.apply(member, object, called)
                    : member;
                },
              });
            };
          }
          return typeof value === "function"
            ? (...args: unknown[]): unknown =>
                Reflect.apply(value, target, args)
            : value;
        },
      });
    const session = await sessionOf(release, {
      on: { ...env, WORKFLOW_RUNS: failingStart(env.WORKFLOW_RUNS) },
    });
    const request = await startOf(release, { who: "Ada" });
    const first = startedAs(await session.start("desk-user", request));
    const afterFailure = await recordedRuns(app);
    const rest: (number | string)[] = [];
    for (let index = 0; index < 10; index += 1) {
      // One after another: each start's own room.
      // oxlint-disable-next-line no-await-in-loop
      rest.push(startedAs(await session.start("desk-user", request)));
    }
    await session.close();
    expect({
      first: typeof first,
      afterFailure,
      started: rest.filter((answer) => typeof answer === "number").length,
      refused: rest.filter((answer) => typeof answer === "string"),
    }).toStrictEqual({
      first: "string",
      afterFailure: [],
      // Its room stayed taken: nine more, then the limit.
      started: 9,
      refused: ["function.call_limit"],
    });
  });

  it("tell a test and its report of a failed run only the platform's code and words, never a value it read", async () => {
    const admin = await person("admin");
    const key = await mailContract(admin);
    let workflowId = "";
    const { app, builder } = await requestsApp(
      async (by) => {
        workflowId = await workflowOf(
          by,
          [
            {
              id: "send",
              type: "call",
              connection: "mail",
              action: "mail.send",
              args: { to: "Ada", subject: { $expr: "params.word" } },
            },
          ],
          {
            permissions: { connections: { mail: { contract: key } } },
            params: {
              word: {
                label: "Word",
                type: { kind: "string", default: "default-word" },
                sensitive: false,
              },
            },
            status: { $expr: "params.word" },
          }
        );
        return workflowId;
      },
      {
        "tests/leak.test.ts": suiteOf(`
      const run = await owner.start(
        workflows.followUp,
        { who: "Ada" },
        { params: { word: "fixture-secret-word" } }
      );
      expect(JSON.stringify(await t.runs.untilTerminal(run))).toBe("shown");`),
      }
    );
    await setWorkflowParams(env, builder, workflowId, {
      expectedRevision: 0,
      values: { word: "org-secret-word" },
    });
    const report = JSON.stringify(await activated(builder, app));
    expect({
      // The test failed, quoting how the run ended, in full.
      failed: report.includes("failed") && report.includes("code"),
      leaked: /secret/u.test(report),
    }).toStrictEqual({ failed: true, leaked: false });
  });

  it("tell a test of a run that failed for a reason of core's own only the platform's words for a step's failure", async () => {
    const { release, app } = await requestsApp(
      async (by) => await workflowOf(by, greeting([hold("1 second")]))
    );
    const session = await sessionOf(release);
    const run = startedAs(
      await session.start("desk-user", await startOf(release, { who: "Ada" }))
    );
    // Its record changed under it: its next activation fails, as core's
    // own error, which names the run.
    await env.DB.prepare(
      "UPDATE app_test_runs SET manifest_hash = ? WHERE app_id = ?"
    )
      .bind("f".repeat(64), app)
      .run();
    const ended = await endOf(session, run);
    await session.close();
    expect(ended).toStrictEqual({
      status: "failed",
      code: "workflow.step_failed",
      message: expectedMessageOf("workflow.step_failed"),
    });
  });

  it("refuse a connector's call: connect is never asked", async () => {
    const admin = await person("admin");
    const key = await mailContract(admin);
    const connectorRun = await requestsApp(
      async (by) =>
        await workflowOf(
          by,
          [
            {
              id: "send",
              type: "call",
              connection: "mail",
              action: "mail.send",
              args: { to: "Ada", subject: "Hi" },
            },
          ],
          {
            permissions: { connections: { mail: { contract: key } } },
            status: "sent",
          }
        )
    );
    const connectBefore = await connectCalls();
    const endedIn = async (
      fixture: Awaited<ReturnType<typeof requestsApp>>
    ): Promise<unknown> => {
      const session = await sessionOf(fixture.release);
      const run = startedAs(
        await session.start(
          "desk-user",
          await startOf(fixture.release, { who: "Ada" })
        )
      );
      const outcome = await endOf(session, run);
      await session.close();
      return outcome;
    };
    expect({
      connector: await endedIn(connectorRun),
      connectAsked: (await connectCalls()) - connectBefore,
    }).toMatchObject({
      connector: { status: "failed", code: "permission.unavailable" },
      connectAsked: 0,
    });
  });

  it("refuse a run's result that is more than the App declares, as a page is shown it", async () => {
    const { release } = await requestsApp(async (by) => {
      const workflow = await createWorkflowResource(
        env,
        by,
        `wider-${unique()}`
      );
      await publishDefinition(
        env,
        by,
        workflow.id,
        JSON.stringify({
          ...JSON.parse(definitionOf([])),
          returns: objectSchema({
            status: { kind: "string" },
            secret: { kind: "string" },
          }),
          result: { status: "hello", secret: "ultramarine" },
        })
      );
      return workflow.id;
    });
    const session = await sessionOf(release);
    const run = startedAs(
      await session.start("desk-user", await startOf(release, { who: "Ada" }))
    );
    const ended = await endOf(session, run);
    await session.close();
    expect({
      ended,
      leaks: JSON.stringify(ended).includes("ultramarine"),
    }).toMatchObject({
      ended: { status: "failed", code: "contract.invalid_return" },
      leaks: false,
    });
  });

  it("run with the parameter values the start gives or their defaults, never the organization's", async () => {
    const params = {
      greeting: {
        label: "Greeting",
        type: { kind: "string", default: "Hello" },
        sensitive: false,
      },
    };
    let workflowId = "";
    let builder: Acting | undefined;
    const { release } = await requestsApp(async (by) => {
      builder = by;
      workflowId = await workflowOf(by, [], {
        params,
        status: { $expr: 'params.greeting + ", " + args.who' },
      });
      return workflowId;
    });
    if (builder === undefined) {
      throw new Error("No builder");
    }
    await setWorkflowParams(env, builder, workflowId, {
      expectedRevision: 0,
      values: { greeting: "Ultramarine" },
    });
    const ended = async (
      options?: Record<string, unknown>
    ): Promise<unknown> => {
      const session = await sessionOf(
        release,
        options === undefined ? {} : { options }
      );
      const run = startedAs(
        await session.start("desk-user", await startOf(release, { who: "Ada" }))
      );
      const outcome = typeof run === "number" ? await endOf(session, run) : run;
      await session.close();
      return outcome;
    };
    expect({
      defaults: await ended(),
      fixture: await ended({ params: { greeting: "Fixture" } }),
      unknown: await ended({ params: { colour: "red" } }),
    }).toStrictEqual({
      defaults: { status: "completed", result: { status: "Hello, Ada" } },
      fixture: { status: "completed", result: { status: "Fixture, Ada" } },
      unknown: "workflow.params_invalid",
    });
  });

  it("move a test's runs' clock on: a sleep due by then runs now, with no wall-clock wait, and a run started later starts at the moved time", async () => {
    const { release, app } = await requestsApp(
      async (by) => await workflowOf(by, greeting([hold("1 hour")]))
    );
    const session = await sessionOf(release);
    const began = Date.now();
    const first = startedAs(
      await session.start("desk-user", await startOf(release, { who: "Ada" }))
    );
    const [firstId = ""] = await recordedRuns(app);
    await sleeping(firstId, "hold");
    const hour = 60 * 60 * 1000;
    const advanced: unknown = JSON.parse(await session.advanceClock(hour));
    const firstEnd = await endOf(session, first);
    // Started once the clock moved an hour on: its own hour's sleep is an
    // hour from then, so it waits until the clock moves on again.
    const second = startedAs(
      await session.start("desk-user", await startOf(release, { who: "Bo" }))
    );
    const both = await recordedRuns(app);
    const secondId = both.find((id) => id !== firstId) ?? "";
    await sleeping(secondId, "hold");
    const beforeAdvance = await statusOnce(secondId, "waiting");
    await session.advanceClock(hour);
    const secondEnd = await endOf(session, second);
    const took = Date.now() - began;
    await session.close();
    expect({ advanced, firstEnd, beforeAdvance, secondEnd }).toStrictEqual({
      advanced: { ok: true, value: null },
      firstEnd: { status: "completed", result: { status: "Hello, Ada" } },
      beforeAdvance: "waiting",
      secondEnd: { status: "completed", result: { status: "Hello, Bo" } },
    });
    // Two hours of sleep, in far less than the test's own deadline.
    expect(took).toBeLessThan(20_000);
  });

  it("move the clock from an App's own test, to a deadline its run waits for", async () => {
    const { builder, app } = await requestsApp(
      async (by) =>
        await workflowOf(
          by,
          greeting([
            { id: "hold", type: "wait", until: { $expr: "params.due" } },
          ]),
          {
            params: {
              due: {
                label: "Due",
                type: { kind: "number", default: 0 },
                sensitive: false,
              },
            },
          }
        ),
      {
        "tests/clock.test.ts": suiteOf(`
      const due = Date.now() + 60 * 60 * 1000;
      const run = await owner.start(
        workflows.followUp,
        { who: "Ada" },
        { params: { due } }
      );
      await t.clock.advance(2 * 60 * 60 * 1000);
      expect(await t.runs.untilTerminal(run)).toEqual({
        status: "completed",
        result: { status: "Hello, Ada" },
      });
      await expect(t.clock.advance(-1)).rejects.toThrow(
        "expected the milliseconds to move the clock on by"
      );`),
      }
    );
    await expect(activated(builder, app)).resolves.toBe("current");
  });

  it("leave no run behind the clock that started as it moved", async () => {
    const { builder, app } = await requestsApp(
      async (by) =>
        await workflowOf(
          by,
          greeting([
            { id: "hold", type: "wait", until: { $expr: "params.due" } },
          ]),
          {
            params: {
              due: {
                label: "Due",
                type: { kind: "number", default: 0 },
                sensitive: false,
              },
            },
          }
        ),
      {
        "tests/clock.test.ts": suiteOf(`
      const hour = 60 * 60 * 1000;
      // Due an hour from now on the wall clock: at once for a run on the
      // moved clock, an hour away for one the move missed.
      const due = Date.now() + hour;
      // Known to core first, so its starts go out at once, beside the move.
      await owner.run(async () => await Promise.resolve(null));
      const started = Array.from({ length: 4 }, async (_unused, index) =>
        await owner.start(
          workflows.followUp,
          { who: \`Ada \${index}\` },
          { params: { due } }
        )
      );
      // The move once the starts have gone out, while core starts them.
      const moved = (async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 1);
        });
        await t.clock.advance(2 * hour);
      })();
      const [runs] = await Promise.all([Promise.all(started), moved]);
      for (const run of runs) {
        expect(await t.runs.untilTerminal(run)).toMatchObject({
          status: "completed",
        });
      }`),
      }
    );
    const began = Date.now();
    await expect(activated(builder, app)).resolves.toBe("current");
    expect(Date.now() - began).toBeLessThan(60_000);
  });

  it("move the clock from an App's own test past each sleep its run has reached, and keep the runs that ended", async () => {
    const { builder, app } = await requestsApp(
      async (by) =>
        await workflowOf(
          by,
          greeting([
            hold("1 hour"),
            { id: "again", type: "wait", for: "1 hour" },
          ])
        ),
      {
        "tests/clock.test.ts": suiteOf(`
      const hour = 60 * 60 * 1000;
      const run = await owner.start(workflows.followUp, { who: "Ada" });
      // Each sleep once the run has reached it: the second only after the
      // first woke, so the advance after it isn't taken by the first.
      await t.runs.untilWaiting(run);
      await t.clock.advance(hour);
      await t.runs.untilWaiting(run);
      await t.clock.advance(hour);
      expect(await t.runs.untilTerminal(run)).toEqual({
        status: "completed",
        result: { status: "Hello, Ada" },
      });
      // Two days on, past what the engine keeps of an ended run: the
      // first run is still there to ask about.
      const later = await owner.start(workflows.followUp, { who: "Bo" });
      await t.runs.untilWaiting(later);
      await t.clock.advance(48 * hour);
      expect(await t.runs.untilTerminal(run)).toMatchObject({ status: "completed" });
      expect(await t.effects.completedCount(run, "greet")).toBe(1);
      await t.runs.untilWaiting(later);
      await t.clock.advance(hour);
      expect(await t.runs.untilTerminal(later)).toEqual({
        status: "completed",
        result: { status: "Hello, Bo" },
      });`),
      }
    );
    const began = Date.now();
    await expect(activated(builder, app)).resolves.toBe("current");
    // An hour's sleep, in far less than the test's own deadline.
    expect(Date.now() - began).toBeLessThan(60_000);
  });

  it("refuse to move the clock by anything but whole milliseconds, or of a run of the organization's", async () => {
    const { release, builder, workflowId } = await requestsApp(
      async (by) => await workflowOf(by, greeting([hold("1 hour")]))
    );
    const session = await sessionOf(release);
    const answerSchema = z.union([
      z.object({ ok: z.literal(true) }),
      z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) }),
    ]);
    const refusedFor = async (ms: unknown): Promise<unknown> => {
      const answer = answerSchema.parse(
        JSON.parse(await session.advanceClock(ms))
      );
      return answer.ok ? "moved" : answer.error.code;
    };
    const asked = {
      negative: await refusedFor(-1),
      fraction: await refusedFor(1.5),
      text: await refusedFor("3600000"),
      tooFar: await refusedFor(400 * 24 * 60 * 60 * 1000),
    };
    await session.close();
    // A run of the organization's, asleep: its object refuses to move its
    // clock, and its sleep stays due when it was (its wake, in its
    // journal; its alarm may move for its outbox meanwhile).
    const { runId } = await startWorkflow(
      env,
      { type: "person", person: builder },
      workflowId,
      { expected: 1, args: { who: "Ada" }, key: unique() }
    );
    if (runId === null) {
      throw new Error("The start admitted no run");
    }
    await sleeping(runId, "hold");
    const wakeOf = async (): Promise<unknown> =>
      await runInDurableObject(runObjectOf(env, runId), (_object, state) =>
        state.storage.sql.exec("SELECT wake_at FROM run").one()
      );
    // Its wake is kept just after the sleep's event goes out.
    const before = await vi.waitFor(async () => {
      const wake = await wakeOf();
      expect(wake).not.toStrictEqual({ wake_at: null });
      return wake;
    });
    const moved = await runObjectOf(env, runId)
      .advanceFixtureClock(60 * 60 * 1000)
      .then(() => "moved")
      .catch((error: unknown) =>
        error instanceof Error ? error.message : "thrown"
      );
    const after = await wakeOf();
    const status = await liveStatus(runId);
    await runEngine(env).terminate(runId);
    // Removed, its object holds the tombstone of its start: still no run
    // of a test's whose clock may move.
    await runEngine(env).remove(runId);
    const movedOnceRemoved = await runObjectOf(env, runId)
      .advanceFixtureClock(60 * 60 * 1000)
      .then(() => "moved")
      .catch((error: unknown) =>
        error instanceof Error ? error.message : "thrown"
      );
    expect(movedOnceRemoved).toBe(
      "Only a run a host's test runs moves its time or restarts."
    );
    expect({ asked, moved, wakeKept: after, status }).toStrictEqual({
      asked: {
        negative: "contract.invalid_args",
        fraction: "contract.invalid_args",
        text: "contract.invalid_args",
        tooFar: "contract.invalid_args",
      },
      moved: "Only a run a host's test runs moves its time or restarts.",
      wakeKept: before,
      status: "waiting",
    });
  });
});
