/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { kitModuleName } from "@grasp-os/compiler";
import { generateWorkflow } from "@grasp-os/open-workflow/generate";
import { validateWorkflow } from "@grasp-os/open-workflow/validate";
import { v } from "@grasp-os/sdk";
import { jsonSchemaOf, schemaFromDescriptor } from "@grasp-os/sdk/host";
import type { ConnectorContract } from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { workflowResourceIdSchema } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type { WorkflowDuration } from "@grasp-os/workerflow/contracts";
import { namedError } from "@grasp-os/workerflow/errors";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { z } from "zod";

import { appFor } from "../src/apps.ts";
import {
  answerDecision,
  confirmDecision,
  reviewDecision,
} from "../src/decisions/decisions.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import {
  approveWorkflowBinding,
  revokeWorkflowBinding,
} from "../src/workflow-bindings.ts";
import {
  generatedModule,
  readSealedTasks,
  sealedTasksText,
} from "../src/workflow-builds.ts";
import type { SealedTask } from "../src/workflow-builds.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { setWorkflowParams } from "../src/workflow-params.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resetWorkflowState, workflowStateOf } from "../src/workflow-state.ts";
import {
  attemptMethods,
  loadRunIsolate,
  runModule,
  runModules,
} from "../src/workflows/code.ts";
import type { StepError } from "../src/workflows/code.ts";
import { runObjectOf } from "../src/workflows/engine.ts";
import { cpuLimitKill, RunHost } from "../src/workflows/host.ts";
import type { HostHooks, RunStep } from "../src/workflows/host.ts";
import type { CallingRun } from "../src/workflows/resource-authority.ts";
import {
  loadedActivation,
  runOf,
  sealedActivation,
} from "../src/workflows/resource-runs.ts";
import { modelCallsIn, sentCallsIn } from "../src/workflows/run-object.ts";
import {
  sealedRun,
  sealedRunFrom,
  sealedRunModules,
  sealedRunStart,
} from "../src/workflows/sealed-run.ts";
import type {
  HostedSealedRun,
  SealedRunKind,
  SealedRunMemory,
} from "../src/workflows/sealed-run.ts";
import { allEvents } from "./audit-events.ts";
import { endLiveResourceRuns } from "./json-workflow-apps.ts";
import { mailConnection } from "./mail-connection.ts";
import { mailControlUrl } from "./mail-server.ts";
import { answeringProvider, connectModels } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { engineOfTest } from "./run-host.ts";
import { admittedFreely, liveStatus } from "./runs.ts";
import { unique } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// A run of a sealed build of a generated JSON workflow on the run host
// (sealed-run.ts), from its threat model. The isolate runs the build's
// code and computes the values of a call's expression holes; the host
// takes nothing else from it on trust. So each test runs a module of its
// own in a real isolate, under the sealed run's main module, against a
// real published workflow's sealed build and a real start's receipt, on
// the run host with an engine of the test's own, as code past the
// generator would. The ways it can fail, each refused:
//
// - a step the sealed table doesn't have;
// - a call that differs from its sealed template: another binding or
//   operation, a changed literal, an extra or a missing key, a list of
//   another length;
// - a sensitive parameter's placeholder of a parameter the build didn't
//   seal there; one in an expression's place, or in a call that isn't a
//   connector's, filled in (it must stay data); a connector's answer or
//   error carrying the secret back;
// - a model call sent twice by its step's attempts, or past the run's
//   ceiling;
// - authority that changed since the start: an approval revoked, the
//   person gone;
// - a call outside its step, or two calls in one attempt;
// - a build whose bytes aren't the ones its hash names.
//
// And the calls the isolate filled in as sealed go out: a connector's, its
// sensitive value put in by the host, audited with the arguments it sent,
// and a model's.

/** The model the organization chose, the one the model binding names. */
const allowedModel = "mistral/mistral-large-latest";

/** A member of the organization with `role`, as their session has them. */
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

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** Where the standard error types are, as a catch's filter names them. */
const standardErrors =
  "https://open-workflow-specification.org/spec/1.0.0/errors/";

/** What mail.send takes, `{ to, subject }`, and answers, `{ messageId }`. */
const mailInput = v.object({ to: v.string(), subject: v.string() });
const mailOutput = v.object({ messageId: v.string() });

const descriptorOf = (schema: { descriptor: unknown }): string =>
  JSON.stringify(schema.descriptor);

const shapeOf = (schema: { descriptor: unknown }) =>
  JSON.stringify(
    jsonSchemaOf(schemaFromDescriptor(descriptorOf(schema)).descriptor, {
      exact: true,
    })
  );

/** `env`, its connect serving mail.send as the catalog contract has it. */
const serving: Env = {
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
const granted = async (
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
 * loop `wide`, of items at once, don't run on the run host yet.
 */
const sealedWorkflow = async () => {
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

type Sealed = Awaited<ReturnType<typeof sealedWorkflow>>;

/** A run of `sealed` started by its builder, once it waits out its hour. */
const waitingRun = async ({ by, workflow }: Sealed): Promise<string> => {
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
const activationOf = async (runId: string) => {
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
const sealedRunOf = async (runId: string): Promise<HostedSealedRun> => {
  const { run } = await activationOf(runId);
  return sealedRunFrom(run);
};

/** The workflow SDK, by the flat name the sealed build has it. */
const sdkWorkflow = JSON.stringify(kitModuleName("@grasp-os/sdk/workflow"));

/**
 * A module of the test's own in place of the build's generated one: a
 * workflow on input `{ who }` whose run is `body`, with `step`, `env`,
 * `input`, `state` and `sensitiveParam` in scope.
 */
const moduleOf = (body: string): string => `
import { sensitiveParam, workflow, z } from ${sdkWorkflow};
export default workflow("sealed", { params: {}, input: z.object({ who: z.string() }) }, async (step, { env, input, state }) => {
${body}
});
`;

/** The engine step of `task`'s own step, as the SDK names it. */
const send = (body: string): string =>
  `return await step.do("send", { key: "task", description: "Its task" }, async () => { ${body} });`;

/**
 * `send`'s call, failing its step, and what its code saw of the failure:
 * its code and message, kept past the step for the run to end with.
 */
const seenOfCall = `
let seen = null;
try {
  ${send('try { return await env.mail.call("mail.send", { to: input.who, subject: sensitiveParam("token") }); } catch (error) { seen = { code: error.code, message: error.message }; throw error; }')}
} catch {}
return seen;`;

/** What `greet` and `again` ask their model, as the build sealed it. */
const greeting =
  '{ instructions: "Greet them.", input: { who: input.who, tags: ["vip", input.who] } }';

/** The engine step of `task`'s own step, asking its model with `args`. */
const greet = (args: string, task = "greet"): string =>
  `return await step.do(${JSON.stringify(task)}, { key: "task", description: "Its task" }, async () => await env.summary.call("grasp.model", ${args}));`;

/** A provider answer greeting Ada, as the model's output schema takes it. */
const hello = {
  text: '{"line":"Hello Ada"}',
  inputTokens: 100,
  outputTokens: 20,
};

const settledSchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({ message: z.string(), code: z.string().optional() }),
  }),
]);

/** Memory of a run's tried-once calls and model calls, this test's own. */
const memoryOfTest = (): SealedRunMemory => {
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
type Engine = Pick<ReturnType<typeof engineOfTest>, "step" | "leaseOf">;

/** How many attempts an engine ran of each step, by its key. */
type Tries = Map<string, number>;

/**
 * An engine that tries each step's function again, as the engine does,
 * while its error may be retried and its retries last, and whose waits
 * for an event end at once.
 */
const retryingEngine = (
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
type Journaled =
  | { ok: true; value: unknown }
  | { ok: false; name: string; message: string; code?: string };

/**
 * An engine that journals each step's outcome in `journal`, and replays a
 * step it journaled without running it again, as the engine does in a
 * later activation: its result, or its error as the engine keeps it (its
 * name, message and code). The steps whose functions ran go in `ran`.
 */
const journalingEngine = (
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
const newerEngine = (): Engine => {
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
 * (`sealedRunModules` refuses it, as tested below).
 */
const modulesOfTest = (
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
const ranAs = async (
  runId: string,
  source: string,
  {
    admitAttempt,
    engine = newerEngine(),
    maxModelCalls,
    calling,
    maxSleepMs,
    keeps,
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
    /**
     * What tasks keep in the workflow's state, by task, as a build of the
     * format to come seals it (`SealedTask.state`).
     */
    keeps?: Readonly<Record<string, Kept>>;
  } = {}
) => {
  const loaded = await sealedRunOf(runId);
  const run = {
    ...loaded,
    ...(keeps === undefined
      ? {}
      : {
          build: {
            ...loaded.build,
            tasks: loaded.build.tasks.map((task) =>
              Object.hasOwn(keeps, task.id)
                ? { ...task, state: keeps[task.id] }
                : task
            ),
          },
        }),
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
const checkedCalls = async (runId: string) => {
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
const refusalsOf = async (runId: string) => {
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

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** Makes mail server `id` answer mail.send with the MCP tool result `result`. */
const toolAnswers = async (id: string, result: unknown): Promise<void> => {
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
const echoingMail = async (id: string, echo: string): Promise<void> => {
  const answered = { messageId: echo };
  await toolAnswers(id, {
    content: [{ type: "text", text: JSON.stringify(answered) }],
    structuredContent: answered,
  });
};

/** Engine step `name` with key `key`, as the SDK names it. */
const engineStep = (name: string, key: string): string =>
  `${name}:${encodeURIComponent(key)}`;

/** A refusal, saying `why`, that ends the run as tampering. */
const refusedAs = (why: string) => ({
  ended: "workflow.invalid",
  why,
  tampered: ["workflow.invalid"],
});

/** Any text, as a matcher. */
const anyText: unknown = expect.any(String);

/** A failure with `code`, the run's code free to take it: no tampering. */
const failedWith = (code: string) => ({
  ended: code,
  why: anyText,
  tampered: [],
});

describe("a sealed build's run on the run host", () => {
  let sealed: Sealed;

  beforeAll(async () => {
    await connectModels(`test-model-key-${crypto.randomUUID()}`, [
      allowedModel,
    ]);
    sealed = await sealedWorkflow();
  });

  afterAll(endLiveResourceRuns);

  it("makes the call whose holes the isolate filled, its sensitive value put in by the host, audited as sent", async () => {
    const runId = await waitingRun(sealed);
    const sent = { to: "Ada", subject: { "$grasp:param": "token" } };
    const ran = await ranAs(
      runId,
      moduleOf(
        send(
          'const answer = await env.mail.call("mail.send", { to: input.who, subject: sensitiveParam("token") }); return { sent: typeof answer.messageId };'
        )
      )
    );
    const events = JSON.stringify(await allEvents());
    const { sent: mail } = await sealed.mail.did();
    expect({
      ran,
      mail,
      checked: await checkedCalls(runId),
      secretAudited: events.includes(sealed.secret),
    }).toStrictEqual({
      ran: { ended: { sent: "string" }, tampered: [] },
      mail: [{ to: "Ada", subject: sealed.secret }],
      checked: [
        {
          step: "send:task",
          call: "grasp.connector",
          binding: "mail",
          operation: "mail.send",
          arguments: await sha256Hex(canonicalJson(sent)),
        },
      ],
      secretAudited: false,
    });
  });

  it("hands the isolate only the parameters that aren't sensitive", async () => {
    const run = await sealedRunOf(await waitingRun(sealed));
    expect({
      frozen: Object.keys(run.params),
      handed: sealedRunStart(run).params,
    }).toStrictEqual({ frozen: ["token"], handed: {} });
  });

  it("refuses a step the build doesn't seal", async () => {
    const runId = await waitingRun(sealed);
    await expect(
      ranAs(
        runId,
        moduleOf(
          'return await step.do("forged", { key: "task", description: "Its task" }, async () => await env.mail.call("mail.send", { to: input.who, subject: sensitiveParam("token") }));'
        )
      )
    ).resolves.toStrictEqual(
      refusedAs('Step "forged:task" isn\'t one the build seals.')
    );
    expect({
      refusals: await refusalsOf(runId),
      checked: await checkedCalls(runId),
    }).toStrictEqual({
      refusals: [{ step: "forged:task", errorCode: "workflow.invalid" }],
      checked: [],
    });
  });

  it("refuses a call through another binding, or of another operation", async () => {
    const otherBinding = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        send(
          'return await env.summary.call("mail.send", { to: input.who, subject: sensitiveParam("token") });'
        )
      )
    );
    const otherOperation = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        send(
          'return await env.mail.call("mail.search", { to: input.who, subject: sensitiveParam("token") });'
        )
      )
    );
    expect({ otherBinding, otherOperation }).toStrictEqual({
      otherBinding: refusedAs('Step "send:task" calls only binding mail.'),
      otherOperation: refusedAs('Step "send:task" calls only mail.send.'),
    });
  });

  it("refuses a changed literal, an extra or a missing key, and a list of another length", async () => {
    const literal = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        greet(
          '{ instructions: "Greet everyone.", input: { who: input.who, tags: ["vip", input.who] } }'
        )
      )
    );
    const extraKey = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        send(
          'return await env.mail.call("mail.send", { to: input.who, subject: sensitiveParam("token"), bcc: "eve@evil.test" });'
        )
      )
    );
    const missingKey = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        send('return await env.mail.call("mail.send", { to: input.who });')
      )
    );
    const longerList = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        greet(
          '{ instructions: "Greet them.", input: { who: input.who, tags: ["vip", input.who, "eve"] } }'
        )
      )
    );
    expect({ literal, extraKey, missingKey, longerList }).toStrictEqual({
      literal: refusedAs(
        "arguments.instructions isn't the value the build sealed."
      ),
      extraKey: refusedAs(
        "arguments hasn't exactly the keys the build sealed."
      ),
      missingKey: refusedAs(
        "arguments hasn't exactly the keys the build sealed."
      ),
      longerList: refusedAs(
        "arguments.input.tags isn't a list of the 2 items the build sealed."
      ),
    });
  });

  it("fills in a sensitive parameter only in its own place: another's placeholder is refused, and one in an expression's place, or in a call that isn't a connector's, is data", async () => {
    const provider = await answeringProvider(() => hello, {
      models: [allowedModel],
    });
    const unsealedName = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        send(
          'return await env.mail.call("mail.send", { to: input.who, subject: sensitiveParam("other") });'
        )
      )
    );
    const inASlot = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        send(
          'return await env.mail.call("mail.send", { to: sensitiveParam("token"), subject: sensitiveParam("token") });'
        )
      )
    );
    const notAConnector = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        greet(
          '{ instructions: "Greet them.", input: { who: sensitiveParam("token"), tags: ["vip", input.who] } }'
        )
      )
    );
    const asked = JSON.stringify(provider.requests.map(({ body }) => body));
    expect({
      unsealedName,
      inASlot,
      notAConnector,
      askedWithPlaceholder: asked.includes("$grasp:param"),
      askedWithSecret: asked.includes(sealed.secret),
    }).toStrictEqual({
      unsealedName: refusedAs(
        'arguments.subject takes only the placeholder of the sensitive parameter "token".'
      ),
      // Its contract takes text there: the placeholder went nowhere.
      inASlot: failedWith("workflow.call_invalid"),
      notAConnector: { ended: { line: "Hello Ada" }, tampered: [] },
      askedWithPlaceholder: true,
      askedWithSecret: false,
    });
  });

  it("makes a model call once: a later attempt of its step fails as the one that sent it, unless it provably billed nothing", async () => {
    const replies: ProviderReply[] = [hello];
    const provider = await answeringProvider(() => replies.shift(), {
      models: [allowedModel],
    });
    const answered = await ranAs(
      await waitingRun(sealed),
      moduleOf(greet(greeting))
    );
    const afterAnswered = provider.requests.length;
    // The call went out, then the engine gave up on its attempt as it ran
    // out of time: the engine tries the step again, and the call doesn't
    // go out again; the next attempt fails as left open, for good.
    replies.push(hello, hello);
    const tries: Tries = new Map();
    const retried = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        `return await step.do("greet", { key: "task", description: "Its task", retries: { limit: 2 } }, async () => await env.summary.call("grasp.model", ${greeting}));`
      ),
      { engine: retryingEngine(tries, new Map(), (attempt) => attempt === 1) }
    );
    const afterRetried = provider.requests.length;
    // Refused for the key, billing nothing: the step waits for a working
    // one, then asks again.
    replies.length = 0;
    replies.push({ status: 401, errorType: "authentication_error" }, hello);
    const unbilled = await ranAs(
      await waitingRun(sealed),
      moduleOf(greet(greeting)),
      { engine: retryingEngine() }
    );
    expect({
      answered,
      afterAnswered,
      retried,
      sentByRetried: afterRetried - afterAnswered,
      // Of the three its retries allow: the refusal ended the step.
      attemptsOfRetried: tries.get("key:greet:task"),
      unbilled,
      sentByUnbilled: provider.requests.length - afterRetried,
    }).toStrictEqual({
      answered: { ended: { line: "Hello Ada" }, tampered: [] },
      afterAnswered: 1,
      retried: failedWith("operation.deadline_exceeded"),
      sentByRetried: 1,
      attemptsOfRetried: 2,
      unbilled: { ended: { line: "Hello Ada" }, tampered: [] },
      sentByUnbilled: 2,
    });
  });

  it("sends a model call whose step's first attempt was cut off in its admission", async () => {
    const provider = await answeringProvider(() => hello, {
      models: [allowedModel],
    });
    let admissions = 0;
    const ran = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        `return await step.do("greet", { key: "task", description: "Its task", retries: { limit: 2 } }, async () => await env.summary.call("grasp.model", ${greeting}));`
      ),
      {
        engine: retryingEngine(),
        admitAttempt: () => async () => {
          admissions += 1;
          // Cut off as it was admitted, as an activation evicted then.
          if (admissions === 1) {
            throw cpuLimitKill();
          }
          return await admittedFreely();
        },
      }
    );
    expect({ ran, sent: provider.requests.length }).toStrictEqual({
      ran: { ended: { line: "Hello Ada" }, tampered: [] },
      sent: 1,
    });
  });

  it("stops at the run's model-call ceiling", async () => {
    await answeringProvider(() => hello, { models: [allowedModel] });
    const ran = await ranAs(
      await waitingRun(sealed),
      moduleOf(`
${greet(greeting).replace("return await", "await")}
${greet(greeting, "again")}
`),
      { maxModelCalls: 1 }
    );
    expect(ran).toStrictEqual(failedWith("workflow.model_call_limit"));
  });

  it("refuses an answer that echoes the sensitive value, which never reaches the isolate", async () => {
    const echoing = await sealedWorkflow();
    await echoingMail(echoing.mail.id, `ref-${echoing.secret}`);
    const runId = await waitingRun(echoing);
    const ran = await ranAs(runId, moduleOf(seenOfCall));
    expect({
      ran,
      seen: JSON.stringify(ran).includes(echoing.secret),
    }).toStrictEqual({
      ran: {
        ended: {
          code: "workflow.call_invalid",
          message: anyText,
        },
        tampered: [],
        untaken: "workflow.call_invalid",
      },
      seen: false,
    });
  });

  it("never hands the isolate a connector's error quoting the sensitive value", async () => {
    // Connect words each of its errors by code, never with what the tool
    // said, and the isolate gets an error's code and message alone.
    const failing = await sealedWorkflow();
    await toolAnswers(failing.mail.id, {
      isError: true,
      content: [
        { type: "text", text: `Refused: ${failing.secret} isn't allowed` },
      ],
    });
    const ran = await ranAs(await waitingRun(failing), moduleOf(seenOfCall));
    expect({
      ran,
      seen: JSON.stringify(ran).includes(failing.secret),
    }).toStrictEqual({
      ran: {
        ended: { code: anyText, message: anyText },
        tampered: [],
        untaken: "connect.outcome_unknown",
      },
      seen: false,
    });
  });

  it("refuses a call outside its step, and a second call in one attempt", async () => {
    const outsideRun = await waitingRun(sealed);
    // Its late call is made once its step has completed: chained, inside
    // the step, on what the module lets go only after the step returned.
    const outside = await ranAs(
      outsideRun,
      moduleOf(`
const before = await env.mail.call("mail.send", { to: input.who, subject: sensitiveParam("token") }).then(() => "sent", () => "refused");
let letGo;
let late;
await step.do("send", { key: "task", description: "Its task" }, async () => {
  const gate = new Promise((resolve) => { letGo = resolve; });
  late = gate.then(() => env.mail.call("mail.send", { to: input.who, subject: sensitiveParam("token") })).then(() => "sent", () => "refused");
  return null;
});
letGo();
return { before, after: await late };
`)
    );
    const twiceRun = await waitingRun(sealed);
    const twice = await ranAs(
      twiceRun,
      moduleOf(
        send(
          'await env.mail.call("mail.send", { to: input.who, subject: sensitiveParam("token") }); return await env.mail.call("mail.send", { to: input.who, subject: sensitiveParam("token") });'
        )
      )
    );
    const twiceChecked = await checkedCalls(twiceRun);
    expect({
      outside,
      checkedOfOutside: await checkedCalls(outsideRun),
      twice,
      checkedOfTwice: twiceChecked.length,
    }).toStrictEqual({
      outside: { ended: { before: "refused", after: "refused" }, tampered: [] },
      checkedOfOutside: [],
      twice: refusedAs('Step "send:task" makes its call once.'),
      // The first went out; the second was refused before it was audited.
      checkedOfTwice: 1,
    });
  });

  it("refuses the next call once an approval is revoked, and the next step once its person is gone", async () => {
    const revoking = await sealedWorkflow();
    const call = moduleOf(
      send(
        'return await env.mail.call("mail.send", { to: input.who, subject: sensitiveParam("token") });'
      )
    );
    const revokedRun = await waitingRun(revoking);
    const goneRun = await waitingRun(revoking);
    await revokeWorkflowBinding(
      serving,
      revoking.admin,
      revoking.workflow.id,
      revoking.approval.id
    );
    const revoked = await ranAs(revokedRun, call);
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(revoking.by.userId)
      .run();
    const gone = await ranAs(goneRun, call);
    const { sent } = await revoking.mail.did();
    expect({
      revoked,
      gone,
      sent,
    }).toStrictEqual({
      revoked: failedWith("workflow.call_denied"),
      gone: failedWith("permission.person_inactive"),
      sent: [],
    });
  });

  it("loads no build generated for another SDK than the run host's: today's published build, unchanged", async () => {
    const run = await sealedRunOf(await waitingRun(sealed));
    expect(run.build.source).toContain("@grasp-os/sdk/open-workflow");
    expect(() => sealedRunModules(run)).toThrow(
      "generated for another SDK than the run host's"
    );
  });

  it("runs no build whose bytes aren't the ones its hash names", async () => {
    const tampered = await sealedWorkflow();
    const row = await env.DB.prepare(
      "SELECT manifest FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
    )
      .bind(tampered.workflow.id)
      .first<{ manifest: string }>();
    const artifact = z
      .object({
        build: z.object({
          artifacts: z.array(
            z.object({ path: z.string(), sha256: z.string() })
          ),
        }),
      })
      .parse(JSON.parse(row?.manifest ?? "{}"))
      .build.artifacts.find(
        ({ path }) => path === `modules/${generatedModule}`
      );
    // Its generated module swapped in storage for code of the attacker's.
    await env.FILES.put(
      `release-artifacts/${artifact?.sha256 ?? ""}`,
      moduleOf(send('return await env.mail.call("mail.send", {});'))
    );
    const { runId } = await startWorkflow(
      serving,
      { type: "person", person: tampered.by },
      tampered.workflow.id,
      { version: 1, input: { who: "Ada" }, key: unique() }
    );
    await expect(sealedRunOf(runId ?? "")).rejects.toMatchObject({
      code: "workflow.version_corrupt",
    });
  });
});

/** Task `id`'s own step, recording `record`, with `options` besides. */
const taskStep = (id: string, record: string, options = ""): string =>
  `await step.do(${JSON.stringify(id)}, { key: "task", description: "Its task"${options} }, async () => (${record}))`;

/** Try `id`'s catch step, deciding by `takes`. */
const catchStep = (id: string, takes: string): string =>
  `await step.caught(${JSON.stringify(id)}, { key: "catch", description: "Its catch" }, ${takes})`;

/** The error `stop` raises, as a catch takes it. */
const stopped = {
  type: "urn:grasp:error:stop",
  status: 422,
  instance: "/do/7/outer/try/0/inner/try/0/stop",
  title: "Stopped.",
};

/** `pause`'s enter step, recording the deadline `until`, as `until`. */
const enterPause = (until: string): string =>
  `const { until } = await step.do("pause", { key: "enter", description: "Its start" }, async () => ({ output: null, until: ${until} }));`;

/** `pause`'s sleep, until `until`. */
const sleepPause = (until: string): string =>
  `await step.sleepUntil("pause", { key: "task", description: "Its sleep", until: ${until} });`;

/** A retry choice naming `by`'s catch, retrying. */
const retryingBy = (by: string): string =>
  `, retry: async () => ({ by: ${JSON.stringify(by)}, retry: true })`;

/** The engine's steps, by key, that a retry of `fetch` ran of `part`. */
const retrySteps = (tries: Tries, part: "decide" | "run"): number =>
  [...tries.keys()].filter(
    (key) =>
      key.startsWith("key:$grasp:wait:") &&
      key.includes(`:retry:`) &&
      key.endsWith(`:${part}`)
  ).length;

// The ways a catch, a raise, a retry or a sleep can fail a sealed run's
// security, each refused or held by the host: a catch taking what its
// sealed filter or the host's mapping doesn't let it, or what it wasn't
// offered; code relabelling the host's failure of its call; a run going
// on past a failure no catch took; a raise run as anything but its sealed
// error; a retry past its policy's rounds, or chosen by a catch that
// can't take the failure; a sleep of another length, or until another
// deadline than the one recorded; an attempt longer than its policy lets.
describe("a sealed run's catches, raises, retries and sleeps on the run host", () => {
  let sealed: Sealed;

  beforeAll(async () => {
    sealed = await sealedWorkflow();
  });

  // Each test's waiting runs end with it: a person's runs of one
  // workflow under way are bounded.
  afterEach(endLiveResourceRuns);

  it("fails a raise with its sealed error, which only a catch whose filter it has takes", async () => {
    const caught = await ranAs(
      await waitingRun(sealed),
      moduleOf(`
const asked = [];
try {
  try {
    ${taskStep("stop", "{ output: null }")};
  } catch (thrown) {
    const inner = ${catchStep("inner", 'async () => { asked.push("inner"); return true; }')};
    if (inner === undefined) throw thrown;
    return { inner };
  }
} catch (thrown) {
  const outer = ${catchStep("outer", "async (error) => { asked.push(error); return true; }")};
  if (outer === undefined) throw thrown;
  return { outer, asked };
}`)
    );
    const uncaught = await ranAs(
      await waitingRun(sealed),
      moduleOf(`return ${taskStep("stop", "{ output: null }")};`)
    );
    const skipped = await ranAs(
      await waitingRun(sealed),
      moduleOf(`return ${taskStep("stop", "{ skipped: true }")};`)
    );
    // Its code throws rather than records: its sealed error all the same.
    const thrown = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        `return ${taskStep("stop", '(() => { throw new Error("not raised"); })()')};`
      )
    );
    // Its code rejects as the Loader's CPU kill would: its sealed error.
    const cutOff = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        `return ${taskStep("stop", '(() => { throw { get name() { throw new Error("Worker exceeded CPU time limit."); } }; })()')};`
      )
    );
    // A catch further in with no conditions takes it: one further out,
    // asked in its place, is offered nothing.
    const passedOver = await ranAs(
      await waitingRun(sealed),
      moduleOf(`
try {
  ${taskStep("boom", "{ output: null }")};
} catch (thrown) {
  return { caught: (${catchStep("wrapped", "async () => true")}) ?? null };
}`)
    );
    expect({
      caught,
      uncaught,
      skipped,
      thrown,
      cutOff,
      passedOver,
    }).toStrictEqual({
      caught: {
        ended: { outer: stopped, asked: [stopped] },
        tampered: [],
      },
      uncaught: failedWith("workflow.raised"),
      skipped: { ended: { skipped: true }, tampered: [] },
      thrown: failedWith("workflow.raised"),
      cutOff: failedWith("workflow.raised"),
      passedOver: {
        ended: { caught: null },
        tampered: [],
        untaken: "workflow.raised",
      },
    });
  });

  it("refuses a run that goes on past a failure no catch took, and a catch that takes what it wasn't offered", async () => {
    const swallowed = `try { ${taskStep("stop", "{ output: null }")}; } catch {}`;
    const nextStep = await ranAs(
      await waitingRun(sealed),
      moduleOf(`${swallowed} return ${taskStep("finish", "{ output: null }")};`)
    );
    const ended = await ranAs(
      await waitingRun(sealed),
      moduleOf(`${swallowed} return "done";`)
    );
    const forged = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        `try { ${taskStep("stop", "{ output: null }")}; } catch { return ${catchStep("outer", 'async () => "yes"')}; }`
      )
    );
    const asDo = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        `return await step.do("outer", { key: "catch", description: "Its catch" }, async () => true);`
      )
    );
    expect({ nextStep, ended, forged, asDo }).toStrictEqual({
      nextStep: refusedAs(
        "A run goes on past a failure only once a catch took it."
      ),
      ended: { ended: "done", tampered: [], untaken: "workflow.raised" },
      forged: refusedAs("A catch takes only the error it was offered."),
      asDo: refusedAs(`Step "outer:catch" isn't one the build seals.`),
    });
  });

  it("fails an attempt with the host's failure of its call, whatever its code makes of it, and takes a failure only its code reports as the task's own", async () => {
    const revoking = await sealedWorkflow();
    const swallowing = await waitingRun(revoking);
    const rejecting = await waitingRun(revoking);
    await revokeWorkflowBinding(
      serving,
      revoking.admin,
      revoking.workflow.id,
      revoking.approval.id
    );
    const swallowed = await ranAs(
      swallowing,
      moduleOf(`
try {
  return ${taskStep("fetch", '(async () => { try { await env.mail.call("mail.send", { to: input.who, subject: "x" }); } catch {} return { output: "sent" }; })()')};
} catch (thrown) {
  const error = ${catchStep("guarded", "async () => true")};
  return { code: thrown.code, caught: error !== undefined };
}`)
    );
    // Its step's function rejects rather than reporting, as code that
    // throws what can't be described makes it, and as the Loader's CPU
    // kill would (a task in no try, which nothing retries).
    const rejected = await ranAs(
      rejecting,
      moduleOf(`
try {
  return ${taskStep("send", '(async () => { try { await env.mail.call("mail.send", { to: input.who, subject: sensitiveParam("token") }); } catch {} throw { get name() { throw new Error("Worker exceeded CPU time limit."); } }; })()')};
} catch (thrown) {
  return { code: thrown.code };
}`)
    );
    // Its call took effect, then its code failed: no catch takes that.
    const afterEffect = await ranAs(
      await waitingRun(sealed),
      moduleOf(`
try {
  ${taskStep("fetch", '(async () => { await env.mail.call("mail.send", { to: input.who, subject: "x" }); throw new Error("after"); })()')};
} catch (thrown) {
  return { code: thrown.code, caught: (${catchStep("guarded", "async () => true")}) ?? null };
}`)
    );
    // Its call took effect, then its lineage had no host call left for a
    // next one: it failed after its effect all the same.
    let hostCalls = 0;
    const spentAfter = await ranAs(
      await waitingRun(sealed),
      moduleOf(`
try {
  ${taskStep("fetch", '(async () => { await env.mail.call("mail.send", { to: input.who, subject: "x" }); await env.mail.call("mail.send", { to: input.who, subject: "x" }).catch(() => null); return { output: "sent" }; })()')};
} catch (thrown) {
  return { code: thrown.code, caught: (${catchStep("guarded", "async () => true")}) ?? null };
}`),
      {
        admitAttempt: () => async () => ({
          ...(await admittedFreely()),
          hostCall: async () => {
            hostCalls += 1;
            if (hostCalls > 1) {
              throw workflowErrors.create("workflow.lineage_limit");
            }
            await Promise.resolve();
          },
        }),
      }
    );
    const relabelled = await ranAs(
      await waitingRun(sealed),
      moduleOf(`
try {
  ${taskStep("fetch", '(() => { const error = new Error("Execution timed out, CPU time limit"); error.code = "connect.outcome_unknown"; throw error; })()')};
} catch (thrown) {
  return { code: thrown.code ?? null, caught: ${catchStep("guarded", "async () => true")} };
}`)
    );
    expect({
      swallowed,
      rejected,
      afterEffect,
      spentAfter,
      relabelled,
    }).toStrictEqual({
      swallowed: {
        ended: { code: "workflow.call_denied", caught: true },
        tampered: [],
      },
      rejected: {
        ended: { code: "workflow.call_denied" },
        tampered: [],
        untaken: "workflow.call_denied",
      },
      afterEffect: {
        ended: { code: "workflow.failed_after_effect", caught: null },
        tampered: [],
        untaken: "workflow.failed_after_effect",
      },
      spentAfter: {
        ended: { code: "workflow.failed_after_effect", caught: null },
        tampered: [],
        untaken: "workflow.failed_after_effect",
      },
      relabelled: {
        ended: {
          code: "internal.unexpected",
          caught: {
            type: `${standardErrors}runtime`,
            status: 500,
            instance: "/do/6/guarded/try/0/fetch",
            title: "Something went wrong.",
          },
        },
        tampered: [],
      },
    });
  });

  it("runs a step again under its catch's retry policy, held to its rounds and its attempts' duration", async () => {
    const tries: Tries = new Map();
    const timeouts = new Map<string, number | WorkflowDuration | undefined>();
    const third = await ranAs(
      await waitingRun(sealed),
      moduleOf(`
let rounds = 0;
return ${taskStep("fetch", '(() => { rounds += 1; if (rounds < 3) throw new Error("not yet"); return { output: rounds }; })()', retryingBy("guarded"))};`),
      { engine: retryingEngine(tries, timeouts) }
    );
    const thirdSteps = {
      decided: retrySteps(tries, "decide"),
      ran: retrySteps(tries, "run"),
      timeout: timeouts.get("key:fetch:task"),
    };
    // Its policy has no conditions: it retries with no retry function.
    const withheld = await ranAs(
      await waitingRun(sealed),
      moduleOf(`
let rounds = 0;
return ${taskStep("fetch", '(() => { rounds += 1; if (rounds < 3) throw new Error("not yet"); return { output: rounds }; })()')};`),
      { engine: retryingEngine() }
    );
    const always = new Map<string, number>();
    const never = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        `return ${taskStep("fetch", '(() => { throw new Error("never"); })()', retryingBy("guarded"))};`
      ),
      { engine: retryingEngine(always) }
    );
    expect({
      third,
      withheld,
      thirdSteps,
      never,
      neverRan: retrySteps(always, "run"),
    }).toStrictEqual({
      third: { ended: { output: 3 }, tampered: [] },
      withheld: { ended: { output: 3 }, tampered: [] },
      thirdSteps: { decided: 2, ran: 2, timeout: 10_000 },
      // Its policy's three rounds, then the failure goes on.
      never: failedWith("internal.unexpected"),
      neverRan: 2,
    });
  });

  it("retries nothing a retry may not fix, and what a policy with no conditions retries whatever its code chooses", async () => {
    const asked = new Map<string, number>();
    const notTransient = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        `return ${taskStep("fetch", '(() => { const error = new Error("bad"); error.code = "expression.failed"; throw error; })()', retryingBy("guarded"))};`
      ),
      { engine: retryingEngine(asked) }
    );
    const wrongCatch = new Map<string, number>();
    const forged = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        `return ${taskStep("fetch", '(() => { throw new Error("again"); })()', retryingBy("outer"))};`
      ),
      { engine: retryingEngine(wrongCatch) }
    );
    // Its retry's code fails where its policy has nothing to decide.
    const failing = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        `return ${taskStep("fetch", '(() => { throw new Error("again"); })()', ', retry: async () => { throw new Error("no choice"); }')};`
      ),
      { engine: retryingEngine() }
    );
    expect({
      notTransient,
      notTransientDecided: retrySteps(asked, "decide"),
      failing,
      forged,
      forgedRan: retrySteps(wrongCatch, "run"),
    }).toStrictEqual({
      notTransient: failedWith("expression.failed"),
      notTransientDecided: 0,
      // The policy's rounds, its code never asked.
      failing: failedWith("internal.unexpected"),
      forged: failedWith("internal.unexpected"),
      forgedRan: 2,
    });
  });

  it("decides a replay as it decided the run: its retries, its sleep's deadline and its catch, from the engine's journal", async () => {
    const module = moduleOf(`
let rounds = 0;
const fetched = ${taskStep("fetch", '(() => { rounds += 1; if (rounds < 3) throw new Error("not yet"); return { output: rounds }; })()', retryingBy("guarded"))};
${enterPause("Date.now() + 1000")}
${sleepPause("until")}
try {
  try {
    ${taskStep("stop", "{ output: null }")};
  } catch (thrown) {
    if (${catchStep("inner", "async () => true")} === undefined) throw thrown;
  }
} catch (thrown) {
  const caught = ${catchStep("outer", "async () => true")};
  if (caught === undefined) throw thrown;
  return { fetched, caught, rounds };
}`);
    const runId = await waitingRun(sealed);
    const journal = new Map<string, Journaled>();
    const first: string[] = [];
    const ran = await ranAs(runId, module, {
      engine: journalingEngine(journal, first),
    });
    const again: string[] = [];
    const replayed = await ranAs(runId, module, {
      engine: journalingEngine(journal, again),
    });
    const outcome = { fetched: { output: 3 }, caught: stopped };
    expect({
      ran,
      decided: first.filter((name) => name.endsWith(":decide")).length,
      replayed,
      ranAgain: again,
    }).toStrictEqual({
      ran: { ended: { ...outcome, rounds: 3 }, tampered: [] },
      decided: 2,
      // Nothing runs again, and nothing is refused: every step, its
      // deadline and its catch, is the journal's.
      replayed: { ended: { ...outcome, rounds: 0 }, tampered: [] },
      ranAgain: [],
    });
  });

  it("refuses a step started while another runs, past the SDK", async () => {
    const ran = await ranAs(
      await waitingRun(sealed),
      // The engine itself, as code past the SDK has it: no \`workflow\`.
      `export default { run: async (engine) => {
  let release = () => undefined;
  const held = new Promise((resolve) => { release = resolve; });
  const first = engine.do("fetch:task", {}, async () => { await held; return { output: 1 }; });
  try {
    await engine.do("finish:task", {}, async () => ({ output: 2 }));
    return "both";
  } catch (error) {
    return error.code;
  } finally {
    release();
    await first.catch(() => null);
  }
} };`
    );
    expect(ran).toStrictEqual({
      ended: "workflow.invalid",
      tampered: ["workflow.invalid"],
    });
  });

  it("lets only the catch its retry's decision named take the failure, and refuses a step that withholds a decision its policy asks for", async () => {
    // Task `ping` fails; the catch of `probe` around it has a condition,
    // and the one of `layered` around that has none, and retries.
    const ping = (retry: string): string =>
      taskStep("ping", '(() => { throw new Error("down"); })()', retry);
    // Its inner catch's condition doesn't hold for the error it sees.
    const catches = `
  if ((${catchStep("probe", "async () => false")}) !== undefined) return "probe";
  return (${catchStep("layered", "async () => true")}) === undefined ? "none" : "layered";`;
    const tries = new Map<string, number>();
    // A workflow of its own: its person's runs of one are bounded.
    const layering = await sealedWorkflow();
    const run = async (retry: string, engine = retryingEngine()) =>
      await ranAs(
        await waitingRun(layering),
        moduleOf(`try { ${ping(retry)}; } catch { ${catches} }`),
        { engine }
      );
    const withheld = await run("");
    // It said the inner catch takes it, then that it doesn't: the outer
    // is offered nothing.
    const probeThenLayered = await run(
      ', retry: async () => ({ by: "probe", retry: false })'
    );
    // It declined the outer catch's retry, which has no conditions.
    const declined = await run(
      ', retry: async () => ({ by: "layered", retry: false })'
    );
    // Its policy's last round has no decision: what an earlier round's
    // named holds no more, and its condition decides afresh.
    const lastRound = await ranAs(
      await waitingRun(layering),
      moduleOf(`try { ${ping(', retry: async () => ({ by: "layered", retry: true })')}; } catch {
  return (${catchStep("probe", "async () => true")}) === undefined ? "none" : "probe";
}`),
      { engine: retryingEngine(tries) }
    );
    expect({
      withheld,
      probeThenLayered,
      declined,
      roundsRun: retrySteps(tries, "run"),
      lastRound,
    }).toStrictEqual({
      withheld: refusedAs(
        `Step "ping:task" gives no retry for its policy to ask.`
      ),
      probeThenLayered: {
        ended: "none",
        tampered: [],
        untaken: "internal.unexpected",
      },
      declined: refusedAs(`Task "layered"'s catch retries the failure.`),
      roundsRun: 2,
      lastRound: { ended: "probe", tampered: [] },
    });
  });

  it("sleeps only as long as sealed, or until exactly the deadline its task recorded", async () => {
    // A workflow of its own: its person's runs of one are bounded.
    const sleeping = await sealedWorkflow();
    const run = async (body: string) =>
      await ranAs(await waitingRun(sleeping), moduleOf(body));
    expect({
      sealedLength: await run(
        'await step.sleep("linger", { key: "task", description: "Its wait", duration: "1 hour" }); return "slept";'
      ),
      otherLength: await run(
        'await step.sleep("linger", { key: "task", description: "Its wait", duration: "1 minute" }); return "slept";'
      ),
      recorded: await run(
        `${enterPause("Date.now() + 1000")} ${sleepPause("until")} return "woke";`
      ),
      otherDeadline: await run(
        `${enterPause("Date.now() + 1000")} ${sleepPause("until - 1")} return "woke";`
      ),
      unrecorded: await run(`${sleepPause("Date.now()")} return "woke";`),
      asDo: await run(`return ${taskStep("pause", "{ output: null }")};`),
      notADuration: await ranAs(
        await waitingRun(sleeping),
        `export default { run: async (engine) => { try { await engine.sleep("pause:task", "x"); return "slept"; } catch (error) { return error.code; } } };`
      ),
      tooFar: await run(
        `${enterPause("Date.now() + 2 * 365 * 86400000")} return "entered";`
      ),
    }).toStrictEqual({
      sealedLength: { ended: "slept", tampered: [] },
      otherLength: refusedAs(`Step "linger:task" isn't one the build seals.`),
      recorded: { ended: "woke", tampered: [] },
      otherDeadline: refusedAs(`Step "pause:task" isn't one the build seals.`),
      unrecorded: refusedAs(`Step "pause:task" isn't one the build seals.`),
      asDo: refusedAs(`Step "pause:task" isn't one the build seals.`),
      notADuration: {
        ended: "workflow.invalid",
        tampered: ["workflow.invalid"],
      },
      tooFar: failedWith("workflow.call_invalid"),
    });
  });

  it("holds a test run's sleeps, deadlines and retry backoffs to its wait limit, which no catch takes", async () => {
    const limited = await sealedWorkflow();
    const caughtOrNot = (steps: string): string => `
try {
  ${steps}
} catch (thrown) {
  const error = ${catchStep("guarded", "async () => true")};
  if (error === undefined) throw thrown;
  return { caught: error.status };
}`;
    const run = async (body: string, maxSleepMs: number, engine?: Engine) =>
      await ranAs(await waitingRun(limited), moduleOf(body), {
        maxSleepMs,
        ...(engine === undefined ? {} : { engine }),
      });
    const minute = 60_000;
    expect({
      sleep: await run(
        'await step.sleep("linger", { key: "task", description: "Its wait", duration: "1 hour" }); return "slept";',
        minute
      ),
      farDeadline: await run(
        `${enterPause("Date.now() + 2 * 60000")} ${sleepPause("until")} return "woke";`,
        minute
      ),
      nearDeadline: await run(
        `${enterPause("Date.now() + 1000")} ${sleepPause("until")} return "woke";`,
        minute
      ),
      // Its policy backs off a second, past the half a second it may wait.
      backoff: await run(
        caughtOrNot(
          `return ${taskStep("fetch", '(() => { throw new Error("not yet"); })()', retryingBy("guarded"))};`
        ),
        500,
        retryingEngine()
      ),
      backoffWithin: await run(
        caughtOrNot(
          `let rounds = 0; return ${taskStep("fetch", '(() => { rounds += 1; if (rounds < 2) throw new Error("not yet"); return { output: rounds }; })()', retryingBy("guarded"))};`
        ),
        minute,
        retryingEngine()
      ),
    }).toStrictEqual({
      sleep: failedWith("workflow.candidate_wait_limit"),
      farDeadline: failedWith("workflow.candidate_wait_limit"),
      nearDeadline: { ended: "woke", tampered: [] },
      backoff: failedWith("workflow.candidate_wait_limit"),
      backoffWithin: { ended: { output: 2 }, tampered: [] },
    });
  });
});

/** How a test's engine ends an activation it evicts. */
const eviction = (): Error => new Error("The activation was evicted");

/**
 * The engine of one activation of a run, `journal` what its activations
 * journaled: a step journaled is replayed, never run again; any other
 * runs once, as attempt `attempt`. The activation is evicted, journaling
 * nothing more, as step `evictedAfter`'s attempt returned, or as step
 * `evictedBefore` was to start.
 */
const activationEngine = (
  journal: Map<string, unknown>,
  {
    attempt = 1,
    evictedAfter,
    evictedBefore,
  }: { attempt?: number; evictedAfter?: string; evictedBefore?: string } = {}
): Engine => {
  const leases = new Set<string>();
  return {
    leaseOf: (key, number) =>
      leases.has(`${number}:${key}`)
        ? { generation: 1000, deadline: Date.now() + 60_000 }
        : undefined,
    step: {
      ...engineOfTest().step,
      do: async (name, _config, fn) => {
        if (journal.has(name)) {
          return journal.get(name);
        }
        if (name === evictedBefore) {
          throw eviction();
        }
        const key = `key:${name}`;
        leases.add(`${attempt}:${key}`);
        try {
          const value = await fn({ attempt, idempotencyKey: key });
          if (name === evictedAfter) {
            throw eviction();
          }
          journal.set(name, value);
          return value;
        } finally {
          leases.delete(`${attempt}:${key}`);
        }
      },
    },
  };
};

/**
 * Runs one activation of run `runId` of its sealed build as its object
 * runs it (resource-runs.ts, `sealedActivation`): inside that object,
 * keeping its sent calls and model calls in the object's own storage, on
 * `engine`, with the test's module `source` in place of the build's
 * generated one. What it answered, or the code it failed with.
 */
const activated = async (
  runId: string,
  source: string,
  engine: Engine,
  maxModelCalls?: number
): Promise<unknown> =>
  await runInDurableObject(runObjectOf(env, runId), async (_object, state) => {
    const activation = await activationOf(runId);
    const loaded = sealedRunFrom(activation.run);
    const run =
      maxModelCalls === undefined ? loaded : { ...loaded, maxModelCalls };
    try {
      return await sealedActivation(
        serving,
        engine.step,
        {
          leaseOf: engine.leaseOf,
          sentCalls: sentCallsIn(state.storage.sql),
          modelCalls: modelCallsIn(state.storage.sql),
        },
        { ...activation, run },
        () => modulesOfTest(run, source)
      );
    } catch (error) {
      const code: unknown =
        error instanceof Error ? Reflect.get(error, "code") : undefined;
      return { failed: typeof code === "string" ? code : String(error) };
    }
  });

// A sealed run's activations as its object runs them (resource-runs.ts,
// `sealedActivation`), from the threat model's "an effect repeated" and
// "a run past what it may spend": what the run's object keeps of its
// calls outlives the activation that made them, so an activation evicted
// mid-step, or a later one replaying its steps, neither sends a call tried
// once again nor spends past its ceiling. And a run whose code ends well
// past a failure no catch took ends failed with that failure.
describe("a sealed run's activations", () => {
  let sealed: Sealed;

  beforeAll(async () => {
    await connectModels(`test-model-key-${crypto.randomUUID()}`, [
      allowedModel,
    ]);
    sealed = await sealedWorkflow();
  });

  afterEach(endLiveResourceRuns);

  it("sends a call tried once only once, though the activation that sent it was evicted before its step was journaled", async () => {
    const provider = await answeringProvider(() => hello, {
      models: [allowedModel],
    });
    const runId = await waitingRun(sealed);
    const source = moduleOf(
      `const { line } = ${taskStep("greet", `await env.summary.call("grasp.model", ${greeting})`)}; return { status: line };`
    );
    const journal = new Map<string, unknown>();
    const evicted = await activated(
      runId,
      source,
      activationEngine(journal, { evictedAfter: "greet:task" })
    );
    const sentBefore = provider.requests.length;
    // The next activation, a fresh host and isolate: the engine tries the
    // step again, as attempt 2.
    const resumed = await activated(
      runId,
      source,
      activationEngine(journal, { attempt: 2 })
    );
    expect({
      evicted,
      sentBefore,
      resumed,
      sent: provider.requests.length,
    }).toStrictEqual({
      evicted: { failed: "internal.unexpected" },
      sentBefore: 1,
      resumed: { failed: "operation.deadline_exceeded" },
      sent: 1,
    });
  });

  it("admits each attempt as its workflow's, on its account's lineage", async () => {
    await answeringProvider(() => hello, { models: [allowedModel] });
    const runId = await waitingRun(sealed);
    const ended = await activated(
      runId,
      moduleOf(
        `const { line } = ${taskStep("greet", `await env.summary.call("grasp.model", ${greeting})`)}; return { status: line };`
      ),
      activationEngine(new Map())
    );
    const admitted = await env.DB.prepare(
      "SELECT resource FROM run_lineage_attempts WHERE run_id = ? AND step_key = 'key:greet:task'"
    )
      .bind(runId)
      .all<{ resource: string }>();
    expect({
      ended,
      admittedAs: admitted.results.map(({ resource }) => resource),
    }).toStrictEqual({
      ended: { status: "Hello Ada" },
      admittedAs: [`workflow-resource:${sealed.workflow.id}`],
    });
  });

  it("holds a replayed run to its model-call ceiling with the calls its earlier activations made", async () => {
    const provider = await answeringProvider(() => hello, {
      models: [allowedModel],
    });
    const runId = await waitingRun(sealed);
    const source = moduleOf(`
${greet(greeting).replace("return await", "await")}
const { line } = ${taskStep("again", `await env.summary.call("grasp.model", ${greeting})`)};
return { status: line };`);
    const journal = new Map<string, unknown>();
    const evicted = await activated(
      runId,
      source,
      activationEngine(journal, { evictedBefore: "again:task" }),
      1
    );
    const replayed = await activated(
      runId,
      source,
      activationEngine(journal),
      1
    );
    expect({
      evicted,
      replayed,
      sent: provider.requests.length,
    }).toStrictEqual({
      evicted: { failed: "internal.unexpected" },
      replayed: { failed: "workflow.model_call_limit" },
      sent: 1,
    });
  });

  it("fails a run whose code ends well past a failure no catch took with that failure, as its code rethrowing it does", async () => {
    const run = async (body: string) =>
      await activated(
        await waitingRun(sealed),
        moduleOf(body),
        activationEngine(new Map())
      );
    const raise = taskStep("stop", "{ output: null }");
    expect({
      swallowed: await run(
        `try { ${raise}; } catch {} return { status: "done" };`
      ),
      rethrown: await run(
        `try { ${raise}; } catch (thrown) { throw thrown; } return { status: "done" };`
      ),
      ended: await run('return { status: "done" };'),
    }).toStrictEqual({
      swallowed: { failed: "workflow.raised" },
      rethrown: { failed: "workflow.raised" },
      ended: { status: "done" },
    });
  });
});

// A sealed run's decisions (`grasp.decision`), from the threat model in
// sealed-run.ts: deciders forged by the isolate, an answer forged or
// taken from the run's own person, a wait for another decision or cut
// short, an answer after the deadline, and a replay asking again.

/** What a decision's answer may carry: nothing, or a comment. */
const decisionAnswers = v.union(v.null(), v.object({ comment: v.string() }));

/**
 * A workflow of `by`'s, published and approved by `admin`: after an hour's
 * wait, task `review` asks its input's `reviewer` to approve its input's
 * invoice through decision binding `approval`, whose deciders are
 * `reviewer` and anyone with the builder role. Then loop `batch` asks
 * the same of each of its invoices (`sign`), one after another.
 */
const decisionWorkflow = async () => {
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

type Reviewed = Awaited<ReturnType<typeof decisionWorkflow>>;

/** A run of `reviewed` its builder started for `reviewer`, waiting its hour. */
const reviewRun = async (
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

/** A module of the test's own whose run on input `{ reviewer, invoice }` is `body`. */
const reviewModuleOf = (body: string): string => `
import { workflow, z } from ${sdkWorkflow};
export default workflow("sealed", { params: {}, input: z.object({ reviewer: z.string(), invoice: z.string() }) }, async (step, { input }) => {
${body}
});
`;

/** Task `review`'s enter step, recording `record` (code) as what it asks. */
const enterReview = (record: string): string =>
  `const entered = await step.do("review", { key: "enter", description: "Its ask" }, async () => (${record}));`;

/** What task `review`'s enter step records, as generated code records it. */
const reviewAsks =
  '{ recipients: [input.reviewer], prompt: "Approve the invoice", input: { invoice: input.invoice } }';

/**
 * Task `review`'s decision, as generated code asks it (`from` code), its
 * outcome and how many people its code was told of, returned.
 */
const decideReview = (from = "entered.recipients[0]"): string => `
const told = [];
const decided = await step.decision("review", { key: "task", description: entered.prompt, from: ${from}, timeout: "365 days", ask: async ({ recipients }) => { told.push(recipients.length); } });
return { decided, told };`;

/** The decisions run `runId` opened, as their rows have them. */
const decisionsOf = async (runId: string) => {
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

/** How many times run `runId` asked the people of a decision, as audited. */
const asksAudited = async (runId: string): Promise<number> => {
  const events = await allEvents();
  return events.filter(
    ({ action, detail }) =>
      action === "workflow.decision.asked" && detail?.run === runId
  ).length;
};

/** `who`'s answer to `decision`, as the decision page gives it. */
const answered = async (
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
const deadlinePasses = async (): Promise<never> => {
  const timedOut = new Error("Execution timed out");
  timedOut.name = "WorkflowTimeoutError";
  return await Promise.reject(timedOut);
};

/**
 * `engine`, each of its waits for a decision's event running `waiting`
 * on the run's only decision, then ending as woken, or as `waiting`
 * throws.
 */
const decidingEngine = (
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
const codeOf = async (work: () => Promise<unknown>): Promise<unknown> => {
  try {
    return await work();
  } catch (error) {
    return error instanceof Error ? Reflect.get(error, "code") : error;
  }
};

/**
 * A refusal of step `step` its code caught and went on past: the run is
 * tampered all the same, and the failure no catch took ends it.
 */
const refusedPastTheSdk = (step: string) => ({
  ended: "workflow.invalid",
  tampered: ["workflow.invalid"],
  untaken: "workflow.invalid",
  refused: [{ step, errorCode: "workflow.invalid" }],
});

/**
 * A run of loop `batch` over two invoices whose code is `body`, with
 * `ask(at)` and `decide(at)` of task `sign` in item `at`.
 */
const signed = (body: string): string => `
const { items } = await step.do("batch", { key: "enter", description: "Its items" }, async () => ({ items: ["INV-1", "INV-2"] }));
const ask = (at) => step.do("sign", { key: "enter@" + at, description: "Its ask" }, async () => ({ recipients: [input.reviewer], prompt: "Approve this one", input: { invoice: items[at] } }));
const decide = (at) => step.decision("sign", { key: "task@" + at, description: "Approve this one", from: input.reviewer, timeout: "365 days", ask: async () => undefined });
${body}`;

describe("a sealed run's decisions on the run host", () => {
  let reviewed: Reviewed;

  beforeAll(async () => {
    reviewed = await decisionWorkflow();
  });

  afterAll(endLiveResourceRuns);

  it("opens the decision its enter step recorded for whom the binding allows, asks them by the host's notice, and answers what they decided, from the decision's row", async () => {
    const { reviewer } = reviewed;
    const runId = await reviewRun(reviewed, `person:${reviewer.userId}`);
    const ran = await ranAs(
      runId,
      reviewModuleOf(`${enterReview(reviewAsks)} ${decideReview()}`),
      {
        engine: decidingEngine(runId, async (decision) => {
          await answered(reviewer, decision, {
            approved: true,
            payload: { comment: "Fine" },
          });
        }),
      }
    );
    const decisions = await decisionsOf(runId);
    expect({
      ran,
      decisions: decisions.map(
        ({ step, deciders, description, input, status }) => ({
          step,
          deciders,
          description,
          input: z.json().parse(JSON.parse(input)),
          status,
        })
      ),
      asked: await asksAudited(runId),
    }).toStrictEqual({
      ran: {
        ended: {
          decided: {
            timedOut: false,
            approved: true,
            by: reviewer.userId,
            payload: { comment: "Fine" },
          },
          // Its code learns nobody's address.
          told: [0],
        },
        tampered: [],
      },
      decisions: [
        {
          step: "review:task",
          deciders: `person:${reviewer.userId}`,
          description: "Approve the invoice",
          input: { invoice: "INV-7" },
          status: "approved",
        },
      ],
      asked: 1,
    });
  });

  it("refuses an ask the build didn't seal, and opens none for deciders the binding doesn't cover or for the run's own person", async () => {
    const { reviewer, by } = reviewed;
    const outsider = await person("user");
    const run = async (who: string, record: string) =>
      await ranAs(
        await reviewRun(reviewed, who),
        reviewModuleOf(`${enterReview(record)} ${decideReview()}`)
      );
    const forReviewer = `person:${reviewer.userId}`;
    expect({
      otherPrompt: await run(
        forReviewer,
        '{ recipients: [input.reviewer], prompt: "Pay it now", input: { invoice: input.invoice } }'
      ),
      extraKey: await run(
        forReviewer,
        '{ recipients: [input.reviewer], prompt: "Approve the invoice", input: { invoice: input.invoice, amount: 1 } }'
      ),
      moreRecipients: await run(
        forReviewer,
        '{ recipients: [input.reviewer, "role:admin"], prompt: "Approve the invoice", input: { invoice: input.invoice } }'
      ),
      uncovered: await run(`person:${outsider.userId}`, reviewAsks),
      // A person's bare ID: its code's `from` couldn't be it exactly.
      bareId: await run(reviewer.userId, reviewAsks),
      ownPerson: await run(`person:${by.userId}`, reviewAsks),
    }).toStrictEqual({
      otherPrompt: refusedAs("prompt isn't the value the build sealed."),
      extraKey: refusedAs("input hasn't exactly the keys the build sealed."),
      moreRecipients: refusedAs(
        "recipients isn't a list of the 1 items the build sealed."
      ),
      uncovered: failedWith("workflow.call_denied"),
      bareId: failedWith("workflow.call_invalid"),
      ownPerson: failedWith("workflow.call_invalid"),
    });
  });

  it("opens a decision only as its enter step recorded it, and refuses a step recording one it didn't open, a reminder, or a wait for another decision", async () => {
    const { reviewer } = reviewed;
    const forReviewer = `person:${reviewer.userId}`;
    // The engine itself, as code past the SDK has it, once task `review`
    // entered as generated code enters it.
    const pastTheSdk = async (body: string) => {
      const runId = await reviewRun(reviewed, forReviewer);
      const ran = await ranAs(
        runId,
        `export default { run: async (engine, input) => {
  await engine.do("review:enter", {}, async () => ({ recipients: [input.reviewer], prompt: "Approve the invoice", input: { invoice: input.invoice } }));
  const open = async () => await engine.do("review:task", {}, async () => await engine.openDecision({ step: "review:task", from: input.reviewer, description: "Approve the invoice", timeout: 1000 }));
  try { ${body} } catch (error) { return error.code; }
} };`
      );
      return { ...ran, refused: await refusalsOf(runId) };
    };
    const outsider = await person("user");
    expect({
      otherFrom: await ranAs(
        await reviewRun(reviewed, forReviewer),
        reviewModuleOf(
          `${enterReview(reviewAsks)} ${decideReview(JSON.stringify(`person:${outsider.userId}`))}`
        )
      ),
      unopened: await pastTheSdk(
        'await engine.do("review:task", {}, async () => ({ decision: "forged", deadline: 1 })); return "recorded";'
      ),
      reminder: await pastTheSdk(
        'const { decision } = await open(); await engine.do("review:task#ask", {}, async () => await engine.decisionRecipients(decision, true)); return "reminded";'
      ),
      otherDecision: await pastTheSdk(
        `await open(); await engine.waitForDecision("review:task#answer", { decision: "${crypto.randomUUID()}", timeout: 1000, last: true }); return "waited";`
      ),
    }).toStrictEqual({
      otherFrom: refusedAs(
        'Task "review" opens its decision as its enter step recorded it.'
      ),
      unopened: refusedPastTheSdk("review:task"),
      reminder: refusedPastTheSdk("review:task#ask"),
      otherDecision: refusedPastTheSdk("review:task#answer"),
    });
  });

  it("waits until the decision's deadline, whatever its code asks, and takes no answer after it", async () => {
    const { reviewer } = reviewed;
    const forReviewer = `person:${reviewer.userId}`;
    // Code past the SDK asking to stop waiting at once, and describing it
    // otherwise than recorded (the SDK passes it trimmed): the host asks
    // the recorded prompt, and waits on.
    const cutShort = await reviewRun(reviewed, forReviewer);
    const waitedOn = await ranAs(
      cutShort,
      `export default { run: async (engine, input) => {
  await engine.do("review:enter", {}, async () => ({ recipients: [input.reviewer], prompt: "Approve the invoice", input: { invoice: input.invoice } }));
  const { decision } = await engine.do("review:task", {}, async () => await engine.openDecision({ step: "review:task", from: input.reviewer, description: "Approve it", timeout: 1000 }));
  return await engine.waitForDecision("review:task#answer", { decision, timeout: 0, last: false });
} };`,
      {
        engine: decidingEngine(cutShort, async (decision) => {
          await answered(reviewer, decision, { approved: false });
        }),
      }
    );
    const lapsed = await reviewRun(reviewed, forReviewer);
    const timedOut = await ranAs(
      lapsed,
      reviewModuleOf(`${enterReview(reviewAsks)} ${decideReview()}`),
      { engine: decidingEngine(lapsed, deadlinePasses) }
    );
    const [closed] = await decisionsOf(lapsed);
    const [described] = await decisionsOf(cutShort);
    expect({
      described: described?.description,
      waitedOn,
      timedOut,
      status: closed?.status,
      lateAnswer: await codeOf(async () => {
        await answered(reviewer, closed?.id ?? "", { approved: true });
      }),
    }).toStrictEqual({
      described: "Approve the invoice",
      waitedOn: {
        ended: {
          answered: true,
          approved: false,
          by: reviewer.userId,
          payload: null,
        },
        tampered: [],
      },
      timedOut: {
        ended: { decided: { timedOut: true }, told: [0] },
        tampered: [],
      },
      status: "timed_out",
      lateAnswer: "decision.closed",
    });
  });

  it("never takes an answer from the run's own person, nor asks or takes one its binding no longer allows", async () => {
    // A workflow of its own: its binding is revoked.
    const revocable = await decisionWorkflow();
    const { by, builder, admin, workflow, approval } = revocable;
    const own = await reviewRun(revocable, "role:builder");
    let refused: unknown;
    const ownRun = await ranAs(
      own,
      reviewModuleOf(`${enterReview(reviewAsks)} ${decideReview()}`),
      {
        engine: decidingEngine(own, async (decision) => {
          // The run's person holds the role the decision asks: still never.
          refused = await codeOf(async () => {
            await answered(by, decision, { approved: true });
          });
          await deadlinePasses();
        }),
      }
    );
    const revoked = await reviewRun(revocable, "role:builder");
    const revokedRun = await ranAs(
      revoked,
      reviewModuleOf(`${enterReview(reviewAsks)} ${decideReview()}`),
      {
        engine: decidingEngine(revoked, async (decision) => {
          await answered(builder, decision, { approved: true });
          await revokeWorkflowBinding(env, admin, workflow.id, approval.id);
        }),
      }
    );
    // Revoked once it opened, before its people are asked: nobody is.
    const unasked = await decisionWorkflow();
    const beforeAsk = await reviewRun(unasked, "role:builder");
    const { step: steps, leaseOf } = newerEngine();
    const askRevoked = await ranAs(
      beforeAsk,
      reviewModuleOf(`${enterReview(reviewAsks)} ${decideReview()}`),
      {
        engine: {
          leaseOf,
          step: {
            ...steps,
            do: async (name, config, fn) => {
              if (name === "review:task#ask") {
                await revokeWorkflowBinding(
                  env,
                  unasked.admin,
                  unasked.workflow.id,
                  unasked.approval.id
                );
              }
              return await steps.do(name, config, fn);
            },
          },
        },
      }
    );
    expect({
      refused,
      ownRun,
      revokedRun,
      askRevoked,
      asked: await asksAudited(beforeAsk),
    }).toStrictEqual({
      refused: "decision.forbidden",
      ownRun: {
        ended: { decided: { timedOut: true }, told: [0] },
        tampered: [],
      },
      revokedRun: failedWith("workflow.call_denied"),
      askRevoked: failedWith("workflow.call_denied"),
      asked: 0,
    });
  });

  it("asks a decision's people once: a step that fails after asking them fails for good", async () => {
    const { reviewer } = reviewed;
    const runId = await reviewRun(reviewed, `person:${reviewer.userId}`);
    const ran = await ranAs(
      runId,
      reviewModuleOf(
        `${enterReview(reviewAsks)} return await step.decision("review", { key: "task", description: entered.prompt, from: entered.recipients[0], timeout: "365 days", ask: async () => { throw new Error("The mail server is down"); } });`
      ),
      { engine: retryingEngine() }
    );
    expect({ ran, asked: await asksAudited(runId) }).toStrictEqual({
      ran: failedWith("workflow.failed_after_effect"),
      asked: 1,
    });
  });

  it("opens no decision, and tells nobody, for a test's run: a draft's or one an App's test started", async () => {
    const { reviewer } = reviewed;
    const run = async (calling: (frozen: CallingRun) => CallingRun) => {
      const runId = await reviewRun(reviewed, `person:${reviewer.userId}`);
      const ran = await ranAs(
        runId,
        reviewModuleOf(`${enterReview(reviewAsks)} ${decideReview()}`),
        { calling }
      );
      return {
        ran,
        decisions: await decisionsOf(runId),
        asked: await asksAudited(runId),
      };
    };
    const opensNone = {
      ran: failedWith("workflow.call_invalid"),
      decisions: [],
      asked: 0,
    };
    expect({
      fixture: await run((frozen) => ({ ...frozen, fixture: true })),
      candidate: await run((frozen) => ({ ...frozen, candidate: new Map() })),
    }).toStrictEqual({ fixture: opensNone, candidate: opensNone });
  });

  it("replays a decision as it ran: the same decision, asked once, and its recorded outcome", async () => {
    const { reviewer } = reviewed;
    const runId = await reviewRun(reviewed, `person:${reviewer.userId}`);
    const journal = new Map<string, Journaled>();
    const source = reviewModuleOf(
      `${enterReview(reviewAsks)} ${decideReview()}`
    );
    const first = await ranAs(runId, source, {
      engine: decidingEngine(
        runId,
        async (decision) => {
          await answered(reviewer, decision, { approved: true });
        },
        journalingEngine(journal, [])
      ),
    });
    const ran: string[] = [];
    const replay = await ranAs(runId, source, {
      engine: decidingEngine(
        runId,
        deadlinePasses,
        journalingEngine(journal, ran)
      ),
    });
    expect({
      replayed: replay.ended,
      ran,
      decisions: await decisionsOf(runId),
      asked: await asksAudited(runId),
    }).toStrictEqual({
      // Its people aren't told again: the ask is journaled.
      replayed: { ...z.object({}).loose().parse(first.ended), told: [] },
      ran: [],
      decisions: [expect.objectContaining({ step: "review:task" })],
      asked: 1,
    });
  });

  it("opens a decision in each item of a loop, each from its own item's ask", async () => {
    const { reviewer } = reviewed;
    // Each wait answers the decision still open: the first approved, the
    // second refused.
    const answering = (runId: string): Engine => {
      const engine = newerEngine();
      return {
        leaseOf: engine.leaseOf,
        step: {
          ...engine.step,
          waitForEvent: async () => {
            const decisions = await decisionsOf(runId);
            const open = decisions.find(({ status }) => status === "open");
            if (open === undefined) {
              throw new Error("No decision to wait for");
            }
            await answered(reviewer, open.id, {
              approved: decisions.length === 1,
            });
            return { payload: null };
          },
        },
      };
    };
    const runId = await reviewRun(reviewed, `person:${reviewer.userId}`);
    const ran = await ranAs(
      runId,
      reviewModuleOf(
        signed(
          "const approved = []; for (let at = 0; at < items.length; at += 1) { await ask(at); approved.push((await decide(at)).approved); } return approved;"
        )
      ),
      { engine: answering(runId) }
    );
    const decisions = await decisionsOf(runId);
    // Item 1 opens its decision without its own ask: item 0's isn't its.
    const otherRunId = await reviewRun(reviewed, `person:${reviewer.userId}`);
    const otherAsk = await ranAs(
      otherRunId,
      reviewModuleOf(
        signed("await ask(0); await decide(0); return await decide(1);")
      ),
      { engine: answering(otherRunId) }
    );
    expect({
      ran,
      decisions: decisions.map(({ step, input, status }) => ({
        step,
        input: z.json().parse(JSON.parse(input)),
        status,
      })),
      otherAsk,
    }).toStrictEqual({
      ran: { ended: [true, false], tampered: [] },
      decisions: [
        {
          step: engineStep("sign", "task@0"),
          input: { invoice: "INV-1" },
          status: "approved",
        },
        {
          step: engineStep("sign", "task@1"),
          input: { invoice: "INV-2" },
          status: "rejected",
        },
      ],
      otherAsk: refusedAs(
        'Task "sign" opens its decision as its enter step recorded it.'
      ),
    });
  });
});

/** Loop `rows`'s enter step, recording `items`, as `items`. */
const enterRows = (items: string): string =>
  `const { items } = await step.do("rows", { key: "enter", description: "Its items" }, async () => ({ items: ${items} }));`;

/** Task `notify`'s call in item `at` of `rows`, mailing `items[at]`. */
const notifyAt = (at: string): string =>
  `await step.do("notify", { key: "task@" + ${at}, description: "Its task" }, async () => typeof (await env.mail.call("mail.send", { to: items[${at}], subject: "loop" })).messageId)`;

/** Task `check`'s raise in item `at` of `rows`, recording `record`. */
const checkAt = (at: string, record = "{ output: null }"): string =>
  `await step.do("check", { key: "task@" + ${at}, description: "Its raise" }, async () => (${record}))`;

/** Try `guard`'s catch in item `at` of `rows`, deciding by `takes`. */
const guardAt = (at: string, takes = "async () => true"): string =>
  `await step.caught("guard", { key: "catch@" + ${at}, description: "Its catch" }, ${takes})`;

/** Task `nap`'s enter step in item `at` of `rows`, recording `until`. */
const napAt = (at: number, until: string): string =>
  `await step.do("nap", { key: "enter@${at}", description: "Its start" }, async () => ({ output: null, until: ${until} }))`;

/** Task `bad`'s raise in item `at` of `cells`, recording `record`. */
const badAt = (at: number, record: string): string =>
  `await step.do("bad", { key: "task@${at}", description: "Its raise" }, async () => (${record}))`;

/** Item `at` of `rows`: its mail, and its raise its own catch takes. */
const rowAt = (at: string): string => `
sent.push(${notifyAt(at)});
try {
  ${checkAt(at)};
} catch (thrown) {
  const error = ${guardAt(at)};
  if (error === undefined) throw thrown;
  caught.push(error.title);
}`;

// The ways loop items can fail a sealed run's security, each refused by
// the host: a step the table doesn't have in items (a fork's branch, a
// loop of items at once, a nested task named as if in no loop, a key in
// another form); an item its loop's enter step never recorded, past its
// count or of a loop it never entered or skipped; items gone back to,
// reordered, run after the run left their loop, or run over by entering
// the loop again; a loop past the platform's 1,000 items; a catch or a
// deadline of another item than the one running; a step past a failure
// pending in an item; an item started without the item step its loop
// seals. And a replay runs every item's steps alike.
describe("a sealed run's loop items on the run host", () => {
  beforeAll(async () => {
    await connectModels(`test-model-key-${crypto.randomUUID()}`, [
      allowedModel,
    ]);
  });

  afterEach(endLiveResourceRuns);

  it("runs a loop's items in order, each step under its item's own name, and a replay alike", async () => {
    const looping = await sealedWorkflow();
    const runId = await waitingRun(looping);
    const journal = new Map<string, Journaled>();
    const firstRan: string[] = [];
    const replayRan: string[] = [];
    const source = moduleOf(`
${enterRows('["a", "b"]')}
const sent = [];
const caught = [];
const slept = [];
const rounds = [];
for (let index = 0; index < items.length; index += 1) {
  ${rowAt("index")}
  rounds[index] = 0;
  await step.do("poke", { key: "task@" + index, description: "Its task", retry: async () => ({ by: "steady", retry: true }) }, async () => { rounds[index] += 1; if (rounds[index] < 2) throw new Error("not yet"); return { output: rounds[index] }; });
  const { until } = await step.do("nap", { key: "enter@" + index, description: "Its start" }, async () => ({ output: null, until: Date.now() + 1000 + index }));
  await step.sleepUntil("nap", { key: "task@" + index, description: "Its sleep", until });
  slept.push(index);
}
return { sent, caught, slept };`);
    const first = await ranAs(runId, source, {
      engine: journalingEngine(journal, firstRan),
    });
    const replayed = await ranAs(runId, source, {
      engine: journalingEngine(journal, replayRan),
    });
    const { sent: mail } = await looping.mail.did();
    const checked = await checkedCalls(runId);
    const ended = {
      sent: ["string", "string"],
      caught: ["Bad row.", "Bad row."],
      slept: [0, 1],
    };
    expect({
      first,
      replayed,
      replayRan,
      mail: mail.map(({ to }) => to),
      checked: checked.map(({ step }) => step),
      journaled: [...journal.keys()].filter((name) => name.includes("%40")),
      // Each item's rounds under steps of its own.
      retried: [...journal.keys()].filter(
        (name) => name.includes(":retry:") && name.endsWith(":run")
      ).length,
    }).toStrictEqual({
      first: { ended, tampered: [] },
      replayed: { ended, tampered: [] },
      replayRan: [],
      mail: ["a", "b"],
      checked: [engineStep("notify", "task@0"), engineStep("notify", "task@1")],
      journaled: [
        engineStep("notify", "task@0"),
        engineStep("check", "task@0"),
        engineStep("guard", "catch@0"),
        engineStep("poke", "task@0"),
        engineStep("nap", "enter@0"),
        engineStep("nap", "task@0"),
        engineStep("notify", "task@1"),
        engineStep("check", "task@1"),
        engineStep("guard", "catch@1"),
        engineStep("poke", "task@1"),
        engineStep("nap", "enter@1"),
        engineStep("nap", "task@1"),
      ],
      retried: 2,
    });
  });

  it("refuses a step in items the table doesn't have, and an item its loop never recorded", async () => {
    const looping = await sealedWorkflow();
    const run = async (body: string) =>
      await ranAs(await waitingRun(looping), moduleOf(body));
    expect({
      forkBranch: await run(
        'return await step.do("left", { key: "task@0", description: "Its task" }, async () => ({ output: null }));'
      ),
      itemsAtOnce: await run(
        'return await step.do("wide", { key: "enter", description: "Its items" }, async () => ({ items: [1, 2] }));'
      ),
      noItem: await run(
        `${enterRows('["a"]')} return await step.do("notify", { key: "task", description: "Its task" }, async () => null);`
      ),
      leadingZero: await run(
        `${enterRows('["a"]')} return ${checkAt('"00"')};`
      ),
      pastCount: await run(
        `${enterRows('["a"]')} const sent = []; sent.push(${notifyAt("0")}); return ${checkAt("1")};`
      ),
      neverEntered: await run(`const items = ["a"]; return ${notifyAt("0")};`),
      skippedLoop: await run(
        `await step.do("rows", { key: "enter", description: "Its items" }, async () => ({ skipped: true })); const items = ["a"]; return ${notifyAt("0")};`
      ),
      // Past the SDK: the key unencoded, as no SDK names it.
      otherEncoding: await ranAs(
        await waitingRun(looping),
        `export default { run: async (engine) => {
  await engine.do("rows:enter", {}, async () => ({ items: ["a"] }));
  try { await engine.do("check:task@0", {}, async () => ({ output: null })); return "ran"; } catch (error) { return error.code; }
} };`
      ),
    }).toStrictEqual({
      forkBranch: refusedAs(
        `Step "${engineStep("left", "task@0")}" isn't one the build seals.`
      ),
      itemsAtOnce: refusedAs(`Step "wide:enter" isn't one the build seals.`),
      noItem: refusedAs(`Step "notify:task" isn't one the build seals.`),
      leadingZero: refusedAs(
        `Step "${engineStep("check", "task@00")}" isn't one the build seals.`
      ),
      pastCount: refusedAs(`Loop "rows" has no item 1 here.`),
      neverEntered: refusedAs(`Loop "rows" has no item 0 here.`),
      skippedLoop: refusedAs(`Loop "rows" has no item 0 here.`),
      otherEncoding: {
        ended: "workflow.invalid",
        tampered: ["workflow.invalid"],
      },
    });
  });

  it("runs items in increasing order, past items that ran no step, and refuses one gone back to, run after the run left its loop, or run over by entering it again", async () => {
    const looping = await sealedWorkflow();
    const run = async (body: string) =>
      await ranAs(
        await waitingRun(looping),
        moduleOf(`${enterRows('["a", "b", "c"]')} const sent = []; ${body}`)
      );
    expect({
      // Items whose work was all skipped run no step: the next goes on.
      emptyFirst: await run(`sent.push(${notifyAt("1")}); return sent;`),
      emptyMiddle: await run(
        `sent.push(${notifyAt("0")}); sent.push(${notifyAt("2")}); return sent;`
      ),
      backAfterSkip: await run(
        `sent.push(${notifyAt("2")}); return ${notifyAt("1")};`
      ),
      reordered: await run(
        `sent.push(${notifyAt("0")}); sent.push(${notifyAt("1")}); return ${checkAt("0")};`
      ),
      afterLeaving: await run(
        `sent.push(${notifyAt("0")}); ${taskStep("finish", "{ output: null }")}; return ${notifyAt("1")};`
      ),
      stoppedEarly: await run(`sent.push(${notifyAt("0")}); return sent;`),
      // Past the SDK, which would refuse a name it ran: the loop entered
      // again to run its items over.
      enteredAgain: await ranAs(
        await waitingRun(looping),
        `export default { run: async (engine) => {
  await engine.do("rows:enter", {}, async () => ({ items: ["a"] }));
  await engine.do(${JSON.stringify(engineStep("check", "task@0"))}, {}, async () => ({ skipped: true }));
  try { await engine.do("rows:enter", {}, async () => ({ items: ["a"] })); return "entered"; } catch (error) { return error.code; }
} };`
      ),
    }).toStrictEqual({
      emptyFirst: { ended: ["string"], tampered: [] },
      emptyMiddle: { ended: ["string", "string"], tampered: [] },
      backAfterSkip: refusedAs(
        `Item 1 of loop "rows" doesn't run now: its items run in increasing order, each once.`
      ),
      reordered: refusedAs(
        `Item 0 of loop "rows" doesn't run now: its items run in increasing order, each once.`
      ),
      afterLeaving: refusedAs(`Loop "rows" has no item 1 here.`),
      stoppedEarly: { ended: ["string"], tampered: [] },
      enteredAgain: {
        ended: "workflow.invalid",
        tampered: ["workflow.invalid"],
      },
    });
  });

  it("holds a loop to 1,000 items, and each item's catch, failure and deadline to that item", async () => {
    const looping = await sealedWorkflow();
    const run = async (body: string) =>
      await ranAs(await waitingRun(looping), moduleOf(body));
    const atMost = await run(
      `${enterRows("Array.from({ length: 1000 }, (_, at) => at)")} return items.length;`
    );
    const tooMany = await run(
      `${enterRows("Array.from({ length: 1001 }, (_, at) => at)")} return items.length;`
    );
    const notAList = await run(
      'await step.do("rows", { key: "enter", description: "Its items" }, async () => ({ output: ["a"] })); return "entered";'
    );
    // Item 0's raise, swallowed: item 1 doesn't start.
    const pastFailure = await run(
      `${enterRows('["a", "b"]')} const sent = []; sent.push(${notifyAt("0")}); try { ${checkAt("0")}; } catch {} return ${notifyAt("1")};`
    );
    // Item 0's raise, offered to item 1's catch.
    const otherCatch = await run(
      `${enterRows('["a", "b"]')} try { ${checkAt("0")}; } catch { return ${guardAt("1")}; }`
    );
    // Item 1 sleeps until item 0's deadline.
    const otherDeadline = await run(`${enterRows('["a", "b"]')}
const first = (${napAt(0, "Date.now() + 1000")}).until;
const sent = [];
sent.push(${notifyAt("1")});
${napAt(1, "first + 500")};
await step.sleepUntil("nap", { key: "task@1", description: "Its sleep", until: first });
return "woke";`);
    expect({
      atMost,
      tooMany,
      notAList,
      pastFailure,
      otherCatch,
      otherDeadline,
    }).toStrictEqual({
      atMost: { ended: 1000, tampered: [] },
      tooMany: failedWith("workflow.collection_invalid"),
      notAList: failedWith("workflow.collection_invalid"),
      pastFailure: refusedAs(
        "A run goes on past a failure only once a catch took it."
      ),
      otherCatch: refusedAs(
        `Item 1 of loop "rows" doesn't run now: its items run in increasing order, each once.`
      ),
      otherDeadline: refusedAs(
        `Step "${engineStep("nap", "task@1")}" isn't one the build seals.`
      ),
    });
  });

  it("leaves a loop by its leave step, or by the catch of a try around it, its items run no more", async () => {
    const looping = await sealedWorkflow();
    const cellsOf = `await step.do("cells", { key: "enter", description: "Its items" }, async () => ({ items: [1, 2] }));`;
    const run = async (body: string) =>
      await ranAs(await waitingRun(looping), moduleOf(`${cellsOf} ${body}`));
    const caughtAround = `try { ${badAt(0, "{ output: null }")}; } catch (thrown) {
  const error = await step.caught("shielded", { key: "catch", description: "Its catch" }, async () => true);
  if (error === undefined) throw thrown;
}`;
    expect({
      caught: await run(`${caughtAround} return "caught";`),
      afterCatch: await run(
        `${caughtAround} return ${badAt(1, "{ skipped: true }")};`
      ),
      afterLeave: await run(
        `${badAt(0, "{ skipped: true }")}; await step.do("cells", { key: "leave", description: "Its output" }, async () => ({ output: null })); return ${badAt(1, "{ skipped: true }")};`
      ),
    }).toStrictEqual({
      caught: { ended: "caught", tampered: [] },
      afterCatch: refusedAs(`Loop "cells" has no item 1 here.`),
      afterLeave: refusedAs(`Loop "cells" has no item 1 here.`),
    });
  });

  it("starts each item of a loop that seals an item step by that step, its while stopping it, in each item of the loop around it", async () => {
    const looping = await sealedWorkflow();
    const pagesOf = `const { items: pages } = await step.do("pages", { key: "enter", description: "Its items" }, async () => ({ items: [["x", "stop"], ["y"]] }));`;
    const nested = await ranAs(
      await waitingRun(looping),
      moduleOf(`${pagesOf}
const seen = [];
for (let page = 0; page < pages.length; page += 1) {
  const { items: lines } = await step.do("lines", { key: "enter@" + page, description: "Its items" }, async () => ({ items: pages[page] }));
  for (let line = 0; line < lines.length; line += 1) {
    const on = await step.do("lines", { key: "item@" + page + "/" + line, description: "Its while" }, async () => lines[line] !== "stop");
    if (!on) break;
    seen.push((await step.do("mark", { key: "task@" + page + "/" + line, description: "Its task" }, async () => ({ output: { seen: lines[line] } }))).output.seen);
  }
}
return seen;`)
    );
    const withoutItemStep = await ranAs(
      await waitingRun(looping),
      moduleOf(`${pagesOf}
await step.do("lines", { key: "enter@0", description: "Its items" }, async () => ({ items: pages[0] }));
return await step.do("mark", { key: "task@0/0", description: "Its task" }, async () => ({ output: null }));`)
    );
    expect({ nested, withoutItemStep }).toStrictEqual({
      nested: { ended: ["x", "y"], tampered: [] },
      withoutItemStep: refusedAs(
        `Item 0 of loop "lines" doesn't run now: its items run in increasing order, each once.`
      ),
    });
  });
});

/** What a task keeps of one key: its template and its value's shape. */
type Kept = NonNullable<SealedTask["state"]>;

/** The descriptor of `schema`, as a build seals it. */
const sealedShape = (schema: { descriptor: unknown }) =>
  z.json().parse(schema.descriptor);

/**
 * What `finish` keeps in the tests below, as a build sealing state does:
 * two expressions' values and a literal, each of its own shape.
 */
const finishKept: Kept = {
  count: { template: { slot: 0 }, value: sealedShape(v.number()) },
  seen: {
    template: { slot: 1 },
    value: sealedShape(v.union(v.string(), v.object({ who: v.string() }))),
  },
  kind: { template: { literal: "visit" }, value: sealedShape(v.string()) },
};

const finishKeeps: Record<string, Kept> = { finish: finishKept };

/** `finish`'s own step, keeping `state` beside its output. */
const keepFinish = (state: string): string =>
  `return ${taskStep("finish", `{ output: { status: "done" }, state: ${state} }`)};`;

/** How many times run `runId`'s steps' state was written, and withheld. */
const stateEvents = async (runId: string) => {
  const events = await allEvents();
  const of = (action: string) =>
    events.filter(
      (event) => event.action === action && event.target?.id === runId
    ).length;
  return {
    written: of("workflow.state.written"),
    withheld: of("workflow.state.withheld"),
  };
};

// What a sealed run keeps between its workflow's runs (workflow-state.ts),
// from its threat model: state the build didn't seal (a key more or
// less, a literal changed, a sensitive parameter, a record of another
// shape); a write by an attempt that failed, or a round its retry ran
// again; a write repeated when its step runs again or is replayed; a test
// run, or a restricted one, writing; a state too large; and a run's
// snapshot changing under it as other runs write.
describe("a sealed run's state between runs on the run host", () => {
  let sealed: Sealed;

  beforeAll(async () => {
    await connectModels(`test-model-key-${crypto.randomUUID()}`, [
      allowedModel,
    ]);
    sealed = await sealedWorkflow();
  });

  beforeEach(async () => {
    await resetWorkflowState(env, sealed.by, sealed.workflow.id);
  });

  afterEach(endLiveResourceRuns);

  it("keeps what its step's sealed state names once it succeeded, once by its step's key, whatever a later run of the step sends", async () => {
    const runId = await waitingRun(sealed);
    const first = await ranAs(
      runId,
      moduleOf(keepFinish('{ count: 1, seen: input.who, kind: "visit" }')),
      { keeps: finishKeeps }
    );
    // Its activation lost before the engine journaled the step: the step
    // runs again, its code sending other values, and writes nothing.
    const again = await ranAs(
      runId,
      moduleOf(keepFinish('{ count: 2, seen: "Bob", kind: "visit" }')),
      { keeps: finishKeeps }
    );
    expect({
      first,
      again,
      state: await workflowStateOf(env, sealed.workflow.id),
      events: await stateEvents(runId),
    }).toStrictEqual({
      first: {
        ended: {
          output: { status: "done" },
          state: { count: 1, seen: "Ada", kind: "visit" },
        },
        tampered: [],
      },
      // Its step succeeded all the same: the first write stands.
      again: {
        ended: {
          output: { status: "done" },
          state: { count: 2, seen: "Bob", kind: "visit" },
        },
        tampered: [],
      },
      state: { count: 1, seen: "Ada", kind: "visit" },
      events: { written: 1, withheld: 0 },
    });
  });

  it("seals what a generated task keeps in the build's task table, and the host holds a run to it", async () => {
    const checked = await validateWorkflow(
      JSON.stringify({
        document: {
          dsl: "1.0.3",
          namespace: workflowNamespace,
          name: "kept",
          version: "1.0.0",
          title: "kept",
          metadata: {
            grasp: {
              profile: "grasp-open-workflow/1",
              params: {},
              bindings: {},
            },
          },
        },
        input: { schema: objectSchema({ who: { type: "string" } }) },
        output: { schema: objectSchema({ status: { type: "string" } }) },
        do: [
          { finish: { set: { status: "done" } } },
          {
            stop: {
              raise: { error: { type: "urn:grasp:error:stop", status: 422 } },
            },
          },
        ],
      }),
      { catalog: () => {} }
    );
    if (!checked.ok) {
      throw new Error("The definition doesn't validate");
    }
    const generated = generateWorkflow(checked.workflow);
    if (!generated.ok) {
      throw new Error("The definition doesn't generate");
    }
    const keeping = (id: string) =>
      sealedTasksText({
        ...generated,
        tasks: generated.tasks.map((task) =>
          task.id === id ? { ...task, state: finishKept } : task
        ),
      });
    const sealedKeeps = readSealedTasks(keeping("finish")).tasks.find(
      ({ id }) => id === "finish"
    )?.state;
    // A raise's step always fails: a build keeping state there is refused.
    let onRaise = "sealed";
    try {
      readSealedTasks(keeping("stop"));
    } catch {
      onRaise = "refused";
    }
    const keeps = { finish: sealedKeeps ?? {} };
    const runId = await waitingRun(sealed);
    const wrong = await ranAs(
      await waitingRun(sealed),
      moduleOf(keepFinish('{ count: "1", seen: input.who, kind: "visit" }')),
      { keeps }
    );
    const right = await ranAs(
      runId,
      moduleOf(keepFinish('{ count: 1, seen: input.who, kind: "visit" }')),
      { keeps }
    );
    expect({
      sealedKeeps,
      onRaise,
      wrong: wrong.tampered,
      right: right.tampered,
      state: await workflowStateOf(env, sealed.workflow.id),
    }).toStrictEqual({
      sealedKeeps: finishKept,
      onRaise: "refused",
      wrong: ["workflow.invalid"],
      right: [],
      state: { count: 1, seen: "Ada", kind: "visit" },
    });
  });

  it("refuses state the build didn't seal, and keeps none of it", async () => {
    const refused = async (
      record: string,
      keeps: Record<string, Kept> = finishKeeps
    ) => {
      const { ended, tampered } = await ranAs(
        await waitingRun(sealed),
        moduleOf(`return ${taskStep("finish", record)};`),
        { keeps }
      );
      return { ended, tampered };
    };
    const asTampering = {
      ended: "workflow.invalid",
      tampered: ["workflow.invalid"],
    };
    expect({
      extraKey: await refused(
        '{ output: null, state: { count: 1, seen: "Ada", kind: "visit", more: 1 } }'
      ),
      missingKey: await refused(
        '{ output: null, state: { count: 1, seen: "Ada" } }'
      ),
      literalChanged: await refused(
        '{ output: null, state: { count: 1, seen: "Ada", kind: "other" } }'
      ),
      noState: await refused("{ output: null }"),
      wrongShape: await refused(
        '{ output: null, state: { count: "one", seen: "Ada", kind: "visit" } }'
      ),
      wrongNested: await refused(
        '{ output: null, state: { count: 1, seen: { who: 7 }, kind: "visit" } }'
      ),
      extraField: await refused(
        '{ output: null, state: { count: 1, seen: "Ada", kind: "visit" }, also: 1 }'
      ),
      sensitive: await refused(
        '{ output: null, state: { secret: sensitiveParam("token") } }',
        {
          finish: {
            secret: {
              template: { param: "token" },
              value: sealedShape(v.string()),
            },
          },
        }
      ),
      state: await workflowStateOf(env, sealed.workflow.id),
    }).toStrictEqual({
      extraKey: asTampering,
      missingKey: asTampering,
      literalChanged: asTampering,
      noState: asTampering,
      wrongShape: asTampering,
      wrongNested: asTampering,
      extraField: asTampering,
      sensitive: asTampering,
      state: {},
    });
  });

  it("writes nothing for a failed round: only the round that succeeded keeps its state", async () => {
    const runId = await waitingRun(sealed);
    const tries: Tries = new Map();
    // `fetch`'s try retries it: its first two rounds fail, each having
    // made what it would keep.
    const retried = await ranAs(
      runId,
      moduleOf(`
let rounds = 0;
return ${taskStep("fetch", '(() => { rounds += 1; const record = { output: null, state: { count: rounds, seen: input.who, kind: "visit" } }; if (rounds < 3) throw new Error("not yet"); return record; })()')};`),
      { keeps: { fetch: finishKept }, engine: retryingEngine(tries) }
    );
    // A step that fails for good, its code going on past it: no write.
    const failed = await waitingRun(sealed);
    await ranAs(
      failed,
      moduleOf(`
try {
  ${taskStep("finish", '(() => { throw new Error("never"); })()')};
} catch {}
return null;`),
      { keeps: finishKeeps, engine: retryingEngine() }
    );
    expect({
      retried: retried.ended,
      rounds: retrySteps(tries, "run"),
      state: await workflowStateOf(env, sealed.workflow.id),
      events: await stateEvents(runId),
      failed: await stateEvents(failed),
    }).toStrictEqual({
      retried: {
        output: null,
        state: { count: 3, seen: "Ada", kind: "visit" },
      },
      rounds: 2,
      state: { count: 3, seen: "Ada", kind: "visit" },
      events: { written: 1, withheld: 0 },
      failed: { written: 0, withheld: 0 },
    });
  });

  it("fails the step whose state is too large, a test run's too, after its call's effect for good, keeping none of it", async () => {
    const tooLarge = keepFinish(
      '{ count: 1, seen: "x".repeat(70000), kind: "visit" }'
    );
    const runId = await waitingRun(sealed);
    const big = await ranAs(runId, moduleOf(tooLarge), { keeps: finishKeeps });
    const draft = await ranAs(await waitingRun(sealed), moduleOf(tooLarge), {
      keeps: finishKeeps,
      calling: (frozen) => ({ ...frozen, candidate: new Map() }),
    });
    // Its mail sent first: no catch may take it as a call that didn't.
    const sent = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        send(
          'await env.mail.call("mail.send", { to: input.who, subject: sensitiveParam("token") }); return { output: null, state: { big: "x".repeat(70000) } };'
        )
      ),
      {
        keeps: {
          send: {
            big: { template: { slot: 0 }, value: sealedShape(v.string()) },
          },
        },
      }
    );
    expect({
      big: { ended: big.ended, tampered: big.tampered },
      draft: { ended: draft.ended, tampered: draft.tampered },
      sent: { ended: sent.ended, tampered: sent.tampered },
      state: await workflowStateOf(env, sealed.workflow.id),
      events: await stateEvents(runId),
    }).toStrictEqual({
      big: { ended: "workflow.state_too_large", tampered: [] },
      draft: { ended: "workflow.state_too_large", tampered: [] },
      sent: { ended: "workflow.failed_after_effect", tampered: [] },
      state: {},
      events: { written: 0, withheld: 0 },
    });
  });

  it("writes nothing for a draft's test run or a restricted run, which still checks its state; a restricted run's skip is audited", async () => {
    const as = async (calling: (frozen: CallingRun) => CallingRun) => {
      const runId = await waitingRun(sealed);
      const valid = await ranAs(
        runId,
        moduleOf(keepFinish('{ count: 1, seen: input.who, kind: "visit" }')),
        { keeps: finishKeeps, calling }
      );
      const tampered = await ranAs(
        await waitingRun(sealed),
        moduleOf(keepFinish('{ count: 1, seen: input.who, kind: "other" }')),
        { keeps: finishKeeps, calling }
      );
      return {
        ended: valid.tampered,
        tampered: tampered.tampered,
        events: await stateEvents(runId),
      };
    };
    expect({
      draft: await as((frozen) => ({ ...frozen, candidate: new Map() })),
      restricted: await as((frozen) => ({ ...frozen, restricted: true })),
      state: await workflowStateOf(env, sealed.workflow.id),
    }).toStrictEqual({
      draft: {
        ended: [],
        tampered: ["workflow.invalid"],
        events: { written: 0, withheld: 0 },
      },
      restricted: {
        ended: [],
        tampered: ["workflow.invalid"],
        events: { written: 0, withheld: 1 },
      },
      state: {},
    });
  });

  it("hands every activation of a run the snapshot its start froze, frozen, whatever other runs write since", async () => {
    await ranAs(
      await waitingRun(sealed),
      moduleOf(
        keepFinish('{ count: 1, seen: { who: input.who }, kind: "visit" }')
      ),
      { keeps: finishKeeps }
    );
    const reader = await waitingRun(sealed);
    // Another run writes after the reader's start.
    await ranAs(
      await waitingRun(sealed),
      moduleOf(keepFinish('{ count: 3, seen: { who: "Bob" }, kind: "visit" }')),
      { keeps: finishKeeps }
    );
    const reads = `return { state, frozen: Object.isFrozen(state) && Object.isFrozen(state.seen) };`;
    // Two activations, each loading the run afresh, as after a restart.
    const first = await ranAs(reader, moduleOf(reads));
    const second = await ranAs(reader, moduleOf(reads));
    const snapshot = {
      ended: {
        state: { count: 1, seen: { who: "Ada" }, kind: "visit" },
        frozen: true,
      },
      tampered: [],
    };
    expect({
      first,
      second,
      now: await workflowStateOf(env, sealed.workflow.id),
    }).toStrictEqual({
      first: snapshot,
      second: snapshot,
      now: { count: 3, seen: { who: "Bob" }, kind: "visit" },
    });
  });
});
