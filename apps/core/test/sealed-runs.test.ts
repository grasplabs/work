/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { kitModuleName } from "@grasp-os/compiler";
import { v } from "@grasp-os/sdk";
import { jsonSchemaOf, schemaFromDescriptor } from "@grasp-os/sdk/host";
import type { ConnectorContract } from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import type { WorkflowDuration } from "@grasp-os/workerflow/contracts";
import { namedError } from "@grasp-os/workerflow/errors";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appFor } from "../src/apps.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import {
  approveWorkflowBinding,
  revokeWorkflowBinding,
} from "../src/workflow-bindings.ts";
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
import { cpuLimitKill, RunHost } from "../src/workflows/host.ts";
import type { HostHooks, RunStep } from "../src/workflows/host.ts";
import {
  sealedAdmission,
  sealedRun,
  sealedRunModules,
  sealedRunOf,
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

/** The workflow SDK, by the flat name the sealed build has it. */
const sdkWorkflow = JSON.stringify(kitModuleName("@grasp-os/sdk/workflow"));

/**
 * A module of the test's own in place of the build's generated one: a
 * workflow on input `{ who }` whose run is `body`, with `step`, `env`,
 * `input` and `sensitiveParam` in scope.
 */
const moduleOf = (body: string): string => `
import { sensitiveParam, workflow, z } from ${sdkWorkflow};
export default workflow("sealed", { params: {}, input: z.object({ who: z.string() }) }, async (step, { env, input }) => {
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
  }: {
    /** How its attempts are admitted, from the run; at once if not given. */
    admitAttempt?: (
      run: HostedSealedRun
    ) => NonNullable<HostHooks["admitAttempt"]>;
    engine?: Engine;
    /** Its model calls' ceiling, in place of the host's. */
    maxModelCalls?: number;
  } = {}
) => {
  const loaded = await sealedRunOf(serving, runId);
  const run =
    maxModelCalls === undefined ? loaded : { ...loaded, maxModelCalls };
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
    // The run host's main module and the build's SDK, as
    // `sealedRunModules` loads them, with the test's module in place of
    // the build's generated one, which today's generator writes for
    // another SDK (`sealedRunModules` refuses it, as tested below).
    modules: async () =>
      await Promise.resolve({
        ...run.build.sdk,
        [generatedModule]: source,
        ...runModules({ module: generatedModule, refusal: "No workflow." }),
      }),
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
    ...(settled.ok && kind?.failureUntaken === true ? { untaken: true } : {}),
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
      ),
      { admitAttempt: (run) => sealedAdmission(serving, run) }
    );
    const admitted = await env.DB.prepare(
      "SELECT resource FROM run_lineage_attempts WHERE run_id = ? AND step_key = 'key:send:task'"
    )
      .bind(runId)
      .all<{ resource: string }>();
    const events = JSON.stringify(await allEvents());
    const { sent: mail } = await sealed.mail.did();
    expect({
      ran,
      mail,
      checked: await checkedCalls(runId),
      admittedAs: admitted.results.map(({ resource }) => resource),
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
      admittedAs: [`workflow-resource:${sealed.workflow.id}`],
      secretAudited: false,
    });
  });

  it("hands the isolate only the parameters that aren't sensitive", async () => {
    const run = await sealedRunOf(serving, await waitingRun(sealed));
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
        untaken: true,
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
        untaken: true,
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
    const run = await sealedRunOf(serving, await waitingRun(sealed));
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
    await expect(sealedRunOf(serving, runId ?? "")).rejects.toMatchObject({
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

  afterAll(endLiveResourceRuns);

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
    expect({ caught, uncaught, skipped, thrown, passedOver }).toStrictEqual({
      caught: {
        ended: { outer: stopped, asked: [stopped] },
        tampered: [],
      },
      uncaught: failedWith("workflow.raised"),
      skipped: { ended: { skipped: true }, tampered: [] },
      thrown: failedWith("workflow.raised"),
      passedOver: { ended: { caught: null }, tampered: [], untaken: true },
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
      ended: { ended: "done", tampered: [], untaken: true },
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
    // throws what can't be described makes it.
    const rejected = await ranAs(
      rejecting,
      moduleOf(`
try {
  return ${taskStep("fetch", '(async () => { try { await env.mail.call("mail.send", { to: input.who, subject: "x" }); } catch {} throw { get name() { throw new Error("undescribable"); } }; })()')};
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
    const relabelled = await ranAs(
      await waitingRun(sealed),
      moduleOf(`
try {
  ${taskStep("fetch", '(() => { const error = new Error("lost"); error.code = "connect.outcome_unknown"; throw error; })()')};
} catch (thrown) {
  return { code: thrown.code ?? null, caught: ${catchStep("guarded", "async () => true")} };
}`)
    );
    expect({ swallowed, rejected, afterEffect, relabelled }).toStrictEqual({
      swallowed: {
        ended: { code: "workflow.call_denied", caught: true },
        tampered: [],
      },
      rejected: {
        ended: { code: "workflow.call_denied" },
        tampered: [],
        untaken: true,
      },
      afterEffect: {
        ended: { code: "workflow.failed_after_effect", caught: null },
        tampered: [],
        untaken: true,
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
      thirdSteps,
      never,
      neverRan: retrySteps(always, "run"),
    }).toStrictEqual({
      third: { ended: { output: 3 }, tampered: [] },
      thirdSteps: { decided: 2, ran: 2, timeout: 10_000 },
      // Its policy's three rounds, then the failure goes on.
      never: failedWith("internal.unexpected"),
      neverRan: 2,
    });
  });

  it("retries nothing a retry may not fix, nor by a catch that can't take the failure", async () => {
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
      failing: refusedAs("A retry with no conditions has nothing to fail on."),
      forged: refusedAs(`Task "outer"'s catch can't take the failure.`),
      forgedRan: 0,
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
      tooFar: failedWith("workflow.call_invalid"),
    });
  });
});
