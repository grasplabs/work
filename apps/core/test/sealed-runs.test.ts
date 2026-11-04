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
} from "../src/workflows/code.ts";
import { RunHost } from "../src/workflows/host.ts";
import type { HostHooks } from "../src/workflows/host.ts";
import {
  sealedAdmission,
  sealedRun,
  sealedRunModules,
  sealedRunOf,
  sealedRunStart,
} from "../src/workflows/sealed-run.ts";
import type { SealedRunMemory } from "../src/workflows/sealed-run.ts";
import { allEvents } from "./audit-events.ts";
import { endLiveResourceRuns } from "./json-workflow-apps.ts";
import { mailConnection } from "./mail-connection.ts";
import { mailControlUrl } from "./mail-server.ts";
import { connectModels } from "./model-provider.ts";
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
// - a sensitive parameter's placeholder outside its place, of a
//   parameter the build didn't seal there, or in a call that isn't a
//   connector's; a connector's answer echoing the secret;
// - authority that changed since the start: an approval revoked, the
//   person gone;
// - a call outside its step, or two calls in one attempt;
// - a build whose bytes aren't the ones its hash names.
//
// And the call the isolate filled in as sealed goes out, its sensitive
// value put in by the host, audited with the arguments it sent.

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
        { finish: { set: { status: "done" } } },
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

/** The engine step of `greet`'s own step, asking its model with `args`. */
const greet = (args: string): string =>
  `return await step.do("greet", { key: "task", description: "Its task" }, async () => await env.summary.call("grasp.model", ${args}));`;

const settledSchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({ message: z.string(), code: z.string().optional() }),
  }),
]);

/** Memory of a run's tried-once calls and model calls, this test's own. */
const memoryOfTest = (): SealedRunMemory => {
  const made = new Set<string>();
  const models: string[] = [];
  return {
    triedOnce: {
      claim: (step) => {
        const fresh = !made.has(step);
        made.add(step);
        return fresh;
      },
      release: (step) => {
        made.delete(step);
      },
    },
    modelCalls: {
      count: () => models.length,
      keep: (key) => {
        models.push(key);
      },
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
  admitAttempt?: (
    run: Awaited<ReturnType<typeof sealedRunOf>>
  ) => NonNullable<HostHooks["admitAttempt"]>
) => {
  const run = await sealedRunOf(serving, runId);
  const { step, leaseOf } = engineOfTest();
  // Its attempts as a newer activation's than the run's own, which a real
  // admission would otherwise take for one it superseded.
  const newer: HostHooks["leaseOf"] = (key, attempt) => {
    const lease = leaseOf(key, attempt);
    return lease === undefined ? undefined : { ...lease, generation: 1000 };
  };
  const tampered: string[] = [];
  const host = new RunHost(
    serving,
    step,
    sealedRun(serving, run, memoryOfTest()),
    {
      stepFailed: () => {
        // The run's end says what failed.
      },
      leaseOf: newer,
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
    modules: async () =>
      await Promise.resolve(
        sealedRunModules({
          sdk: run.build.sdk,
          modules: { [generatedModule]: source },
        })
      ),
    attemptMethods,
  });
  const settled = settledSchema.parse(
    await code.run(host, sealedRunStart(run))
  );
  return {
    ended: settled.ok ? settled.value : settled.error.code,
    ...(settled.ok ? {} : { why: settled.error.message }),
    tampered,
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

/** Makes mail server `id` answer mail.send with `messageId` `echo`. */
const echoingMail = async (id: string, echo: string): Promise<void> => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  const answered = { messageId: echo };
  await providers.fetch(mailControlUrl(id.slice("connection-".length)), {
    method: "POST",
    body: JSON.stringify({
      answers: {
        "mail.send": {
          content: [{ type: "text", text: JSON.stringify(answered) }],
          structuredContent: answered,
        },
      },
    }),
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
      (run) => sealedAdmission(serving, run)
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

  it("refuses a sensitive parameter's placeholder outside its place, of another parameter, or in a call that isn't a connector's", async () => {
    const runs = [
      await waitingRun(sealed),
      await waitingRun(sealed),
      await waitingRun(sealed),
    ];
    const outsideItsPlace = await ranAs(
      runs[0] ?? "",
      moduleOf(
        send(
          'return await env.mail.call("mail.send", { to: sensitiveParam("token"), subject: sensitiveParam("token") });'
        )
      )
    );
    const unsealedName = await ranAs(
      runs[1] ?? "",
      moduleOf(
        send(
          'return await env.mail.call("mail.send", { to: input.who, subject: sensitiveParam("other") });'
        )
      )
    );
    const notAConnector = await ranAs(
      runs[2] ?? "",
      moduleOf(
        'return await step.do("greet", { key: "task", description: "Its task" }, async () => await env.summary.call("grasp.model", { instructions: "Greet them.", input: { who: sensitiveParam("token"), tags: ["vip", input.who] } }));'
      )
    );
    expect({
      outsideItsPlace,
      unsealedName,
      notAConnector,
      checked: await Promise.all(runs.map(checkedCalls)),
    }).toStrictEqual({
      outsideItsPlace: refusedAs(
        "arguments.to holds a placeholder the build has no place for."
      ),
      unsealedName: refusedAs(
        'arguments.subject takes only the placeholder of the sensitive parameter "token".'
      ),
      notAConnector: refusedAs(
        "arguments.input.who holds a placeholder the build has no place for."
      ),
      // None of them went out.
      checked: [[], [], []],
    });
  });

  it("refuses an answer that echoes the sensitive value, which never reaches the isolate", async () => {
    const echoing = await sealedWorkflow();
    await echoingMail(echoing.mail.id, `ref-${echoing.secret}`);
    const runId = await waitingRun(echoing);
    const ran = await ranAs(
      runId,
      moduleOf(
        send(
          'try { return await env.mail.call("mail.send", { to: input.who, subject: sensitiveParam("token") }); } catch (error) { return { code: error.code, message: error.message }; }'
        )
      )
    );
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
      },
      seen: false,
    });
  });

  it("refuses a call outside its step, and a second call in one attempt", async () => {
    const outsideRun = await waitingRun(sealed);
    const outside = await ranAs(
      outsideRun,
      moduleOf(`
const before = await env.mail.call("mail.send", { to: input.who, subject: sensitiveParam("token") }).then(() => "sent", (error) => error.code);
let late;
await step.do("send", { key: "task", description: "Its task" }, async () => {
  late = new Promise((resolve) => setTimeout(resolve, 0)).then(() => env.mail.call("mail.send", { to: input.who, subject: sensitiveParam("token") })).then(() => "sent", (error) => error.code ?? error.message);
  return null;
});
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
      outside: {
        ended: {
          // Before any step there is no attempt to call through; after its
          // step, the runtime let go of the attempt's host.
          before: "workflow.outside_step",
          after: "RPC stub used after being disposed.",
        },
        tampered: [],
      },
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
