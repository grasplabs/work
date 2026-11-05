/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { kitModuleName } from "@grasp-os/compiler";
import { v } from "@grasp-os/sdk";
import { jsonSchemaOf, schemaFromDescriptor } from "@grasp-os/sdk/host";
import type { ConnectorContract } from "@grasp-os/shared/connect";
import { workflowResourceIdSchema } from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import type { WorkflowDuration } from "@grasp-os/workerflow/contracts";
import { namedError } from "@grasp-os/workerflow/errors";
import { env } from "cloudflare:workers";
import { expect, vi } from "vite-plus/test";
import { z } from "zod";

import { appFor } from "../src/apps.ts";
import {
  answerDecision,
  confirmDecision,
  reviewDecision,
} from "../src/decisions/decisions.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { generatedModule } from "../src/workflow-builds.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { setWorkflowParams } from "../src/workflow-params.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import {
  attemptMethods,
  loadRunIsolate,
  runModule,
  runModules,
} from "../src/workflows/code.ts";
import type { StepError } from "../src/workflows/code.ts";
import { RunHost } from "../src/workflows/host.ts";
import type { HostHooks, RunStep } from "../src/workflows/host.ts";
import type { CallingRun } from "../src/workflows/resource-authority.ts";
import { loadedActivation, runOf } from "../src/workflows/resource-runs.ts";
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
import { allEvents } from "./audit-events.ts";
import { mailConnection } from "./mail-connection.ts";
import { mailControlUrl } from "./mail-server.ts";
import { engineOfTest } from "./run-host.ts";
import { admittedFreely, liveStatus } from "./runs.ts";
import { unique } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// The run host's harness for a sealed build's run (sealed-run.ts), shared
// by the tests that run a module of their own against a real published
// workflow's sealed build: sealed-runs.test.ts, and the runs of
// grasp-workflow/1's generated code (workflow-schema-runs.test.ts).

/** The model the organization chose, the one the model binding names. */
export const allowedModel = "mistral/mistral-large-latest";

/** A member of the organization with `role`, as their session has them. */
export const person = async (role: Role): Promise<Identity> => {
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

export const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** Where the standard error types are, as a catch's filter names them. */
export const standardErrors =
  "https://open-workflow-specification.org/spec/1.0.0/errors/";

/** What mail.send takes, `{ to, subject }`, and answers, `{ messageId }`. */
export const mailInput = v.object({ to: v.string(), subject: v.string() });
export const mailOutput = v.object({ messageId: v.string() });

export const descriptorOf = (schema: { descriptor: unknown }): string =>
  JSON.stringify(schema.descriptor);

export const shapeOf = (schema: { descriptor: unknown }) =>
  JSON.stringify(
    jsonSchemaOf(schemaFromDescriptor(descriptorOf(schema)).descriptor, {
      exact: true,
    })
  );

/** `env`, its connect serving mail.send as the catalog contract has it. */
export const serving: Env = {
  ...env,
  CONNECT: new Proxy(env.CONNECT, {
    get: (target, name): unknown =>
      name === "connectorContract"
        ? async (): Promise<ConnectorContract> =>
            await Promise.resolve({
              contract: "composio.mail@1",
              actions: {
                send: {
                  tool: "mail.send",
                  readOnly: false,
                  input: shapeOf(mailInput),
                  output: shapeOf(mailOutput),
                },
              },
            })
        : Reflect.get(target, name),
  }),
};

/** A permission `by` asks for and `admin` grants. */
export const granted = async (
  by: Identity,
  admin: Identity,
  request: PermissionRequest
): Promise<string> => {
  const asked = await requestPermission(env, by, request, {
    app: async (named: string, role: "user" | "builder") =>
      await appFor(env, by, named, role),
    resource: async (ref, needed) => {
      await requireResourceRole(env, by, ref, needed);
    },
  });
  await grantPermission(env, admin, asked.id, { version: null });
  return asked.id;
};

/**
 * A workflow of `by`'s, published and approved by `admin`: after an hour's
 * wait, task `send` mails its input's `who` through connector binding
 * `mail`, the subject its sensitive `token` parameter as a binding
 * argument (`secret`), and task `greet` asks model binding `summary`.
 * Loop `rows` runs its items one after another, each mailing its row
 * (`notify`), raising what its own try's catch takes (`check` in
 * `guard`), mailing again under a retry policy (`poke` in `steady`) and
 * sleeping until a deadline (`nap`); loop `pages` runs loop
 * `lines` in each item, its items stopped by a `while`; loop `cells`,
 * in try `shielded`, raises in each item (`bad`); fork `both` and
 * loop `wide`, of items at once, don't run on the run host yet. `extra`
 * tasks come last.
 */
export const sealedWorkflow = async (extra: readonly unknown[] = []) => {
  const admin = await person("admin");
  const by = await person("builder");
  const mailKey = `mail-${unique()}`;
  await publishCatalogContract(env, admin, {
    key: mailKey,
    kind: "connector",
    operations: {
      "mail.send": {
        input: descriptorOf(mailInput),
        output: descriptorOf(mailOutput),
      },
    },
  });
  const modelKey = `summary-${unique()}`;
  await publishCatalogContract(env, admin, { key: modelKey, kind: "model" });
  const workflow = await createWorkflowResource(env, by, `sealed-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: JSON.stringify({
      document: {
        dsl: "1.0.3",
        namespace: workflowNamespace,
        name: workflow.name,
        version: "1.0.0",
        title: workflow.name,
        metadata: {
          grasp: {
            profile: "grasp-open-workflow/1",
            params: {
              token: {
                schema: { type: "string", maxLength: 64 },
                label: "Token",
                default: "none",
                sensitive: true,
              },
            },
            bindings: {
              mail: { kind: "connector", contract: mailKey },
              summary: { kind: "model", contract: modelKey },
            },
          },
        },
      },
      input: { schema: objectSchema({ who: { type: "string" } }) },
      output: { schema: objectSchema({ status: { type: "string" } }) },
      do: [
        { linger: { wait: "PT1H" } },
        {
          send: {
            call: "grasp.connector",
            with: {
              binding: "mail",
              operation: "mail.send",
              arguments: {
                to: "${ $workflow.input.who }",
                subject: "${ $params.token }",
              },
            },
          },
        },
        {
          greet: {
            call: "grasp.model",
            with: {
              binding: "summary",
              instructions: "Greet them.",
              input: {
                who: "${ $workflow.input.who }",
                tags: ["vip", "${ $workflow.input.who }"],
              },
              outputSchema: objectSchema({ line: { type: "string" } }),
            },
          },
        },
        {
          again: {
            call: "grasp.model",
            with: {
              binding: "summary",
              instructions: "Greet them.",
              input: {
                who: "${ $workflow.input.who }",
                tags: ["vip", "${ $workflow.input.who }"],
              },
              outputSchema: objectSchema({ line: { type: "string" } }),
            },
          },
        },
        { finish: { set: { status: "done" } } },
        {
          pause: {
            call: "grasp.sleepUntil",
            with: {
              timestamp: "${ $workflow.startedAt.epoch.milliseconds + 3000 }",
            },
          },
        },
        {
          guarded: {
            try: [
              {
                fetch: {
                  call: "grasp.connector",
                  timeout: { after: { seconds: 20 } },
                  with: {
                    binding: "mail",
                    operation: "mail.send",
                    arguments: { to: "${ $workflow.input.who }", subject: "x" },
                  },
                },
              },
            ],
            catch: {
              errors: { with: { type: `${standardErrors}runtime` } },
              retry: {
                delay: { seconds: 1 },
                limit: { attempt: { count: 3, duration: { seconds: 10 } } },
              },
            },
          },
        },
        {
          outer: {
            try: [
              {
                inner: {
                  try: [
                    {
                      stop: {
                        raise: {
                          error: {
                            type: "urn:grasp:error:stop",
                            status: 422,
                            title: "Stopped.",
                          },
                        },
                      },
                    },
                  ],
                  catch: { errors: { with: { status: 409 } } },
                },
              },
            ],
            catch: { errors: { with: { status: 422 } } },
          },
        },
        {
          wrapped: {
            try: [
              {
                shield: {
                  try: [
                    {
                      boom: {
                        raise: {
                          error: { type: "urn:grasp:error:boom", status: 418 },
                        },
                      },
                    },
                  ],
                  catch: { errors: { with: { status: 418 } } },
                },
              },
            ],
            catch: { errors: { with: { status: 418 } } },
          },
        },
        {
          layered: {
            try: [
              {
                probe: {
                  try: [
                    {
                      ping: {
                        call: "grasp.connector",
                        with: {
                          binding: "mail",
                          operation: "mail.send",
                          arguments: {
                            to: "${ $workflow.input.who }",
                            subject: "y",
                          },
                        },
                      },
                    },
                  ],
                  catch: {
                    errors: { with: { status: 500 } },
                    when: '${ $workflow.input.who == "Ada" }',
                  },
                },
              },
            ],
            catch: {
              errors: { with: { status: 500 } },
              retry: {
                delay: { seconds: 1 },
                limit: { attempt: { count: 3 } },
              },
            },
          },
        },
        {
          rows: {
            for: { each: "row", in: '${ ["a", "b", "c"] }' },
            do: [
              {
                notify: {
                  call: "grasp.connector",
                  with: {
                    binding: "mail",
                    operation: "mail.send",
                    arguments: { to: "${ $row }", subject: "loop" },
                  },
                },
              },
              {
                guard: {
                  try: [
                    {
                      check: {
                        raise: {
                          error: {
                            type: "urn:grasp:error:bad",
                            status: 409,
                            title: "Bad row.",
                          },
                        },
                      },
                    },
                  ],
                  catch: { errors: { with: { status: 409 } } },
                },
              },
              {
                steady: {
                  try: [
                    {
                      poke: {
                        call: "grasp.connector",
                        with: {
                          binding: "mail",
                          operation: "mail.send",
                          arguments: { to: "${ $row }", subject: "again" },
                        },
                      },
                    },
                  ],
                  catch: {
                    errors: { with: { type: `${standardErrors}runtime` } },
                    retry: {
                      delay: { seconds: 1 },
                      limit: { attempt: { count: 3 } },
                    },
                  },
                },
              },
              {
                nap: {
                  call: "grasp.sleepUntil",
                  with: {
                    timestamp:
                      "${ $workflow.startedAt.epoch.milliseconds + 3000 }",
                  },
                },
              },
            ],
          },
        },
        {
          pages: {
            for: {
              each: "page",
              at: "pageAt",
              in: '${ [["x", "stop"], ["y"]] }',
            },
            do: [
              {
                lines: {
                  for: { each: "line", at: "lineAt", in: "${ $page }" },
                  while: '${ $line != "stop" }',
                  do: [{ mark: { set: { seen: "${ $line }" } } }],
                },
              },
            ],
          },
        },
        {
          shielded: {
            try: [
              {
                cells: {
                  for: { each: "cell", at: "cellAt", in: "${ [1, 2] }" },
                  output: { as: "${ . }" },
                  do: [
                    {
                      bad: {
                        raise: {
                          error: { type: "urn:grasp:error:cell", status: 451 },
                        },
                      },
                    },
                  ],
                },
              },
            ],
            catch: { errors: { with: { status: 451 } } },
          },
        },
        {
          both: {
            fork: {
              branches: [
                { left: { set: { side: "left" } } },
                { right: { set: { side: "right" } } },
              ],
            },
          },
        },
        {
          wide: {
            for: { each: "w", in: "${ [1, 2] }" },
            metadata: { grasp: { concurrency: 2 } },
            do: [{ spread: { set: { w: "${ $w }" } } }],
          },
        },
        ...extra,
      ],
    }),
    basedOn: null,
  });
  const mail = await mailConnection();
  const permissionId = await granted(by, admin, {
    subject: { type: "workflow", workflowId: workflow.id },
    object: { type: "connection", connectionId: mail.id },
    actions: ["mail.send"],
    binding: `MAIL_${unique().toUpperCase().replaceAll("-", "_")}`,
  });
  const approval = await approveWorkflowBinding(serving, admin, workflow.id, {
    alias: "mail",
    target: { kind: "connector", permissionId, contract: "composio.mail@1" },
    reviewed: { version: 1 },
  });
  await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "summary",
    target: { kind: "model", model: allowedModel },
    reviewed: { version: 1 },
  });
  const secret = `secret-${unique()}`;
  await setWorkflowParams(env, by, workflow.id, {
    values: { token: secret },
    expectedRevision: 0,
  });
  return { admin, by, workflow, mail, approval, secret };
};

export type Sealed = Awaited<ReturnType<typeof sealedWorkflow>>;

/** A run of `sealed` started by its builder, once it waits out its hour. */
export const waitingRun = async ({
  by,
  workflow,
}: Pick<Sealed, "by" | "workflow">): Promise<string> => {
  const { runId } = await startWorkflow(
    serving,
    { type: "person", person: by },
    workflow.id,
    { version: 1, input: { who: "Ada" }, key: unique() }
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
 * What an activation of run `runId` runs, as the dispatcher loads it
 * (resource-runs.ts, `loadedActivation`, through the pin its row has).
 */
export const activationOf = async (runId: string) => {
  const row = await runOf(serving, runId);
  if (row === undefined) {
    throw new Error(`Run ${runId} has no row`);
  }
  return await loadedActivation(
    serving,
    {
      workflow: workflowResourceIdSchema.parse(row.workflowResourceId),
      version: row.version,
      manifest: row.manifestHash,
    },
    runId
  );
};

/** Run `runId` as its activation loads it, served on the run host. */
export const sealedRunOf = async (runId: string): Promise<HostedSealedRun> => {
  const { run } = await activationOf(runId);
  return sealedRunFrom(run);
};

/** The workflow SDK, by the flat name the sealed build has it. */
export const sdkWorkflow = JSON.stringify(
  kitModuleName("@grasp-os/sdk/workflow")
);

/**
 * A module of the test's own in place of the build's generated one: a
 * workflow on input `{ who }` whose run is `body`, with `step`, `env`,
 * `input` and `sensitiveParam` in scope.
 */
export const moduleOf = (body: string): string => `
import { sensitiveParam, workflow, z } from ${sdkWorkflow};
export default workflow("sealed", { params: {}, input: z.object({ who: z.string() }) }, async (step, { env, input }) => {
${body}
});
`;

/** The engine step of `task`'s own step, as the SDK names it. */
export const send = (body: string): string =>
  `return await step.do("send", { key: "task", description: "Its task" }, async () => { ${body} });`;

/**
 * `send`'s call, failing its step, and what its code saw of the failure:
 * its code and message, kept past the step for the run to end with.
 */
export const seenOfCall = `
let seen = null;
try {
  ${send('try { return await env.mail.call("mail.send", { to: input.who, subject: sensitiveParam("token") }); } catch (error) { seen = { code: error.code, message: error.message }; throw error; }')}
} catch {}
return seen;`;

/** What `greet` and `again` ask their model, as the build sealed it. */
export const greeting =
  '{ instructions: "Greet them.", input: { who: input.who, tags: ["vip", input.who] } }';

/** The engine step of `task`'s own step, asking its model with `args`. */
export const greet = (args: string, task = "greet"): string =>
  `return await step.do(${JSON.stringify(task)}, { key: "task", description: "Its task" }, async () => await env.summary.call("grasp.model", ${args}));`;

/** A provider answer greeting Ada, as the model's output schema takes it. */
export const hello = {
  text: '{"line":"Hello Ada"}',
  inputTokens: 100,
  outputTokens: 20,
};

export const settledSchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({ message: z.string(), code: z.string().optional() }),
  }),
]);

/** Memory of a run's tried-once calls and model calls, this test's own. */
export const memoryOfTest = (): SealedRunMemory => {
  const sent = new Set<string>();
  const failures = new Map<string, StepError>();
  const models: string[] = [];
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
    modelCalls: {
      count: () => models.length,
      keep: (key) => {
        models.push(key);
      },
    },
  };
};

/** An engine of the test's own, as `engineOfTest`'s. */
export type Engine = Pick<ReturnType<typeof engineOfTest>, "step" | "leaseOf">;

/** How many attempts an engine ran of each step, by its key. */
export type Tries = Map<string, number>;

/**
 * An engine that tries each step's function again, as the engine does,
 * while its error may be retried and its retries last, and whose waits
 * for an event end at once.
 */
export const retryingEngine = (
  tries: Tries = new Map(),
  /** Each step's attempt timeout, as the host configured it, by its key. */
  timeouts = new Map<string, number | WorkflowDuration | undefined>(),
  /** Whether the engine gives up on attempt `attempt` as it times out. */
  timesOut: (attempt: number) => boolean = () => false
): Engine => {
  const leases = new Set<string>();
  const step: RunStep = {
    do: async (name, config, fn) => {
      const key = `key:${name}`;
      timeouts.set(key, config.timeout);
      const limit = config.retries?.limit ?? 0;
      for (let attempt = 1; ; attempt += 1) {
        leases.add(`${attempt}:${key}`);
        tries.set(key, attempt);
        try {
          // oxlint-disable-next-line no-await-in-loop -- one attempt at a time
          const value = await fn({ attempt, idempotencyKey: key });
          if (timesOut(attempt)) {
            const timedOut = new Error("Execution timed out");
            timedOut.name = "WorkflowTimeoutError";
            throw timedOut;
          }
          return value;
        } catch (error) {
          if (
            attempt > limit ||
            (error instanceof Error && error.name === "NonRetryableError")
          ) {
            throw error;
          }
        } finally {
          leases.delete(`${attempt}:${key}`);
        }
      }
    },
    sleep: async () => {
      await Promise.resolve();
    },
    sleepUntil: async () => {
      await Promise.resolve();
    },
    waitForEvent: async () => await Promise.resolve({ payload: null }),
    waitForMatch: async () => await Promise.reject(new Error("No waits here")),
  };
  return {
    step,
    leaseOf: (key, attempt) =>
      leases.has(`${attempt}:${key}`)
        ? { generation: 1000, deadline: Date.now() + 60_000 }
        : undefined,
  };
};

/** What an engine journaled of a step: its result, or the error it failed with. */
export type Journaled =
  | { ok: true; value: unknown }
  | { ok: false; name: string; message: string; code?: string };

/**
 * An engine that journals each step's outcome in `journal`, and replays a
 * step it journaled without running it again, as the engine does in a
 * later activation: its result, or its error as the engine keeps it (its
 * name, message and code). The steps whose functions ran go in `ran`.
 */
export const journalingEngine = (
  journal: Map<string, Journaled>,
  ran: string[]
): Engine => {
  const { step, leaseOf } = retryingEngine();
  const replayed = async (
    name: string,
    run: () => Promise<unknown>
  ): Promise<unknown> => {
    const kept = journal.get(name);
    if (kept?.ok === true) {
      return kept.value;
    }
    if (kept !== undefined) {
      throw namedError(kept.name, kept.message, kept.code);
    }
    try {
      const value = await run();
      journal.set(name, { ok: true, value });
      return value;
    } catch (error) {
      const code: unknown =
        error instanceof Error ? Reflect.get(error, "code") : undefined;
      journal.set(name, {
        ok: false,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        ...(typeof code === "string" ? { code } : {}),
      });
      throw error;
    }
  };
  return {
    leaseOf,
    step: {
      ...step,
      do: async (name, config, fn) =>
        await replayed(name, async () => {
          ran.push(name);
          return await step.do(name, config, fn);
        }),
      sleep: async (name, duration) => {
        await replayed(name, async () => {
          await step.sleep(name, duration);
          return null;
        });
      },
      sleepUntil: async (name, until) => {
        await replayed(name, async () => {
          await step.sleepUntil(name, until);
          return null;
        });
      },
    },
  };
};

/**
 * `engineOfTest`, its attempts a newer activation's than the run's own,
 * which a real admission would otherwise take for one it superseded.
 */
export const newerEngine = (): Engine => {
  const { step, leaseOf } = engineOfTest();
  return {
    step,
    leaseOf: (key, attempt) => {
      const lease = leaseOf(key, attempt);
      return lease === undefined ? undefined : { ...lease, generation: 1000 };
    },
  };
};

/**
 * The modules a sealed run's isolate loads, as `sealedRunModules` loads
 * them, with the test's module `source` in place of the build's generated
 * one, which today's generator writes for another SDK
 * (`sealedRunModules` refuses it, as sealed-runs.test.ts tests).
 */
export const modulesOfTest = (
  run: HostedSealedRun,
  source: string
): Record<string, string> => ({
  ...run.build.sdk,
  [generatedModule]: source,
  ...runModules({ module: generatedModule, refusal: "No workflow." }),
});

/**
 * Runs `source` (`moduleOf`) as run `runId` of its sealed build, on the run
 * host, its attempts admitted by `admitAttempt` (at once by default):
 * what it ended with (its value, or its error's code), and what the host
 * refused as tampering.
 */
export const ranAs = async (
  runId: string,
  source: string,
  {
    admitAttempt,
    engine = newerEngine(),
    maxModelCalls,
    calling,
    maxSleepMs,
    sealed = (loaded) => loaded,
  }: {
    /** How its attempts are admitted, from the run; at once if not given. */
    admitAttempt?: (
      run: HostedSealedRun
    ) => NonNullable<HostHooks["admitAttempt"]>;
    engine?: Engine;
    /** Its model calls' ceiling, in place of the host's. */
    maxModelCalls?: number;
    /** What its calls go by, from what its start froze. */
    calling?: (frozen: CallingRun) => CallingRun;
    /** Its waits' limit, as a test run's. */
    maxSleepMs?: number;
    /** The run as loaded, changed: its build's table in place, say. */
    sealed?: (run: HostedSealedRun) => HostedSealedRun;
  } = {}
) => {
  const loaded = sealed(await sealedRunOf(runId));
  const run = {
    ...loaded,
    ...(maxModelCalls === undefined ? {} : { maxModelCalls }),
    ...(calling === undefined ? {} : { calling: calling(loaded.calling) }),
    ...(maxSleepMs === undefined ? {} : { maxSleepMs }),
  };
  const { step, leaseOf } = engine;
  const tampered: string[] = [];
  let kind: SealedRunKind | undefined;
  const host = new RunHost(
    serving,
    step,
    (controls) => {
      kind = sealedRun(serving, run, memoryOfTest())(controls);
      return kind;
    },
    {
      stepFailed: () => {
        // The run's end says what failed.
      },
      leaseOf,
      tampered: (error) => {
        tampered.push(error.code ?? error.message);
      },
      waiting: async () => {
        await Promise.resolve();
      },
      admitAttempt: admitAttempt?.(run) ?? admittedFreely,
    }
  );
  const code = loadRunIsolate(serving, {
    owner: `test:${runId}`,
    mainModule: runModule,
    modules: async () => await Promise.resolve(modulesOfTest(run, source)),
    attemptMethods,
  });
  const settled = settledSchema.parse(
    await code.run(host, sealedRunStart(run))
  );
  return {
    ended: settled.ok ? settled.value : settled.error.code,
    ...(settled.ok ? {} : { why: settled.error.message }),
    tampered,
    // A failure no catch took, as the run's code ended well past it.
    ...(settled.ok && kind?.failureUntaken !== undefined
      ? { untaken: kind.failureUntaken.code }
      : {}),
  };
};

/** The calls of run `runId` the host checked, as the audit log has them. */
export const checkedCalls = async (runId: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, target }) =>
        action === "workflow.call.checked" && target?.id === runId
    )
    .map(({ detail }) => ({
      step: detail?.step,
      call: detail?.call,
      binding: detail?.binding,
      operation: detail?.operation,
      arguments: detail?.arguments,
    }));
};

/** What the host refused of run `runId`, as the audit log has it. */
export const refusalsOf = async (runId: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, target }) =>
        action === "workflow.call.refused" && target?.id === runId
    )
    .map(({ detail }) => ({
      step: detail?.step,
      errorCode: detail?.errorCode,
    }));
};

export const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** Makes mail server `id` answer mail.send with the MCP tool result `result`. */
export const toolAnswers = async (
  id: string,
  result: unknown
): Promise<void> => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  await providers.fetch(mailControlUrl(id.slice("connection-".length)), {
    method: "POST",
    body: JSON.stringify({ answers: { "mail.send": result } }),
  });
};

/** Makes mail server `id` answer mail.send with `messageId` `echo`. */
export const echoingMail = async (id: string, echo: string): Promise<void> => {
  const answered = { messageId: echo };
  await toolAnswers(id, {
    content: [{ type: "text", text: JSON.stringify(answered) }],
    structuredContent: answered,
  });
};

/** Engine step `name` with key `key`, as the SDK names it. */
export const engineStep = (name: string, key: string): string =>
  `${name}:${encodeURIComponent(key)}`;

/** A refusal, saying `why`, that ends the run as tampering. */
export const refusedAs = (why: string) => ({
  ended: "workflow.invalid",
  why,
  tampered: ["workflow.invalid"],
});

/** Any text, as a matcher. */
export const anyText: unknown = expect.any(String);

/** A failure with `code`, the run's code free to take it: no tampering. */
export const failedWith = (code: string) => ({
  ended: code,
  why: anyText,
  tampered: [],
});

/** What a decision's answer may carry: nothing, or a comment. */
export const decisionAnswers = v.union(
  v.null(),
  v.object({ comment: v.string() })
);

/**
 * A workflow of `by`'s, published and approved by `admin`: after an hour's
 * wait, task `review` asks its input's `reviewer` to approve its input's
 * invoice through decision binding `approval`, whose deciders are
 * `reviewer` and anyone with the builder role. Then loop `batch` asks
 * the same of each of its invoices (`sign`), one after another.
 */
export const decisionWorkflow = async () => {
  const admin = await person("admin");
  const by = await person("builder");
  const reviewer = await person("user");
  const builder = await person("builder");
  const contract = `approval-${unique()}`;
  await publishCatalogContract(env, admin, {
    key: contract,
    kind: "decision",
    input: descriptorOf(v.object({ invoice: v.string() })),
    response: descriptorOf(decisionAnswers),
  });
  const workflow = await createWorkflowResource(env, by, `review-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: JSON.stringify({
      document: {
        dsl: "1.0.3",
        namespace: workflowNamespace,
        name: workflow.name,
        version: "1.0.0",
        title: workflow.name,
        metadata: {
          grasp: {
            profile: "grasp-open-workflow/1",
            params: {},
            bindings: { approval: { kind: "decision", contract } },
          },
        },
      },
      input: {
        schema: objectSchema({
          reviewer: { type: "string" },
          invoice: { type: "string" },
        }),
      },
      output: {
        schema: objectSchema({
          answered: { type: "boolean" },
          approved: { type: "boolean" },
          by: { type: "string" },
          value: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                properties: { comment: { type: "string" } },
                required: ["comment"],
                additionalProperties: false,
              },
            ],
          },
        }),
      },
      do: [
        { linger: { wait: "PT1H" } },
        {
          review: {
            call: "grasp.decision",
            with: {
              binding: "approval",
              recipients: ["${ $workflow.input.reviewer }"],
              prompt: "Approve the invoice",
              input: { invoice: "${ $workflow.input.invoice }" },
            },
            timeout: { after: { days: 7 } },
          },
        },
        {
          batch: {
            for: { each: "inv", at: "invAt", in: '${ ["INV-1", "INV-2"] }' },
            do: [
              {
                sign: {
                  call: "grasp.decision",
                  with: {
                    binding: "approval",
                    recipients: ["${ $workflow.input.reviewer }"],
                    prompt: "Approve this one",
                    input: { invoice: "${ $inv }" },
                  },
                  timeout: { after: { days: 7 } },
                },
              },
            ],
          },
        },
      ],
    }),
    basedOn: null,
  });
  const approval = await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "approval",
    target: {
      kind: "decision",
      deciders: [`person:${reviewer.userId}`, "role:builder"],
    },
    reviewed: { version: 1 },
  });
  return { admin, by, reviewer, builder, workflow, approval };
};

export type Reviewed = Awaited<ReturnType<typeof decisionWorkflow>>;

/** A run of `reviewed` its builder started for `reviewer`, waiting its hour. */
export const reviewRun = async (
  { by, workflow }: Reviewed,
  reviewer: string
): Promise<string> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    workflow.id,
    { version: 1, input: { reviewer, invoice: "INV-7" }, key: unique() }
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

/** The decisions run `runId` opened, as their rows have them. */
export const decisionsOf = async (runId: string) => {
  const rows = await env.DB.prepare(
    "SELECT id, step, deciders, description, input, status FROM workflow_decisions WHERE resource_run_id = ? ORDER BY opened_at"
  )
    .bind(runId)
    .all<{
      id: string;
      step: string;
      deciders: string;
      description: string;
      input: string;
      status: string;
    }>();
  return rows.results;
};

/** `who`'s answer to `decision`, as the decision page gives it. */
export const answerAs = async (
  who: Identity,
  decision: string,
  answer: { approved: boolean; payload?: { comment: string } | null }
): Promise<void> => {
  const review = await reviewDecision(env, who, decision, answer);
  if (review.state === "recorded") {
    return;
  }
  const { confirmation } = await confirmDecision(
    env,
    who,
    decision,
    review.decision.revision,
    review.response
  );
  await answerDecision(env, who, decision, review.response, confirmation);
};

/** A decision's wait that ends as its deadline passes. */
export const deadlinePasses = async (): Promise<never> => {
  const timedOut = new Error("Execution timed out");
  timedOut.name = "WorkflowTimeoutError";
  return await Promise.reject(timedOut);
};

/**
 * `engine`, each of its waits for a decision's event running `waiting`
 * on the run's only decision, then ending as woken, or as `waiting`
 * throws.
 */
export const decidingEngine = (
  runId: string,
  waiting: (decision: string) => Promise<void>,
  engine: Engine = newerEngine()
): Engine => ({
  leaseOf: engine.leaseOf,
  step: {
    ...engine.step,
    waitForEvent: async () => {
      const [opened] = await decisionsOf(runId);
      if (opened === undefined) {
        throw new Error("No decision to wait for");
      }
      await waiting(opened.id);
      return { payload: null };
    },
  },
});

/** The code a refused or failed step's error carries, as a run's code sees it. */
export const codeOf = async (
  work: () => Promise<unknown>
): Promise<unknown> => {
  try {
    return await work();
  } catch (error) {
    return error instanceof Error ? Reflect.get(error, "code") : error;
  }
};
