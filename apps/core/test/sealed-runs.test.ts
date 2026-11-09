import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import { valueDepth } from "@grasp-os/shared/value-depth";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type { WorkflowDuration } from "@grasp-os/workerflow/contracts";
import { generatorVersion } from "@grasp-os/workflow-schema/generate";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vite-plus/test";
import { z } from "zod";

import { revokeWorkflowBinding } from "../src/workflow-bindings.ts";
import { generatedModule } from "../src/workflow-builds.ts";
import {
  exportedWorkflowVersion,
  publishWorkflowVersion,
  workflowVersions,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { runObjectOf } from "../src/workflows/engine.ts";
import { cpuLimitKill } from "../src/workflows/host.ts";
import type { CallingRun } from "../src/workflows/resource-authority.ts";
import { sealedActivation } from "../src/workflows/resource-runs.ts";
import { modelCallsIn, sentCallsIn } from "../src/workflows/run-object.ts";
import {
  sealedRunFrom,
  sealedRunModules,
  sealedRunStart,
} from "../src/workflows/sealed-run.ts";
import { allEvents } from "./audit-events.ts";
import { endLiveResourceRuns } from "./json-workflow-apps.ts";
import { answeringProvider, connectModels } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { engineOfTest } from "./run-host.ts";
import { admittedFreely } from "./runs.ts";
import { artifactKey } from "./sealed-apps.ts";
import {
  activationOf,
  allowedModel,
  answerAs,
  anyText,
  checkedCalls,
  codeOf,
  deadlinePasses,
  decidingEngine,
  decisionsOf,
  decisionWorkflow,
  echoingMail,
  engineStep,
  failedWith,
  greet,
  objectOf,
  greeting,
  hello,
  journalingEngine,
  moduleOf,
  modulesOfTest,
  newerEngine,
  person,
  ranAs,
  refusalsOf,
  refusedAs,
  retryingEngine,
  reviewRun,
  sdkWorkflow,
  sealedRunOf,
  sealedWorkflow,
  seenOfCall,
  send,
  serving,
  standardErrors,
  toolAnswers,
  waitingRun,
} from "./sealed-run-harness.ts";
import type {
  Engine,
  Journaled,
  Reviewed,
  Sealed,
  Tries,
} from "./sealed-run-harness.ts";
import { unique } from "./sign-in.ts";

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
/**
 * A sealed workflow whose version 1 is as one published before: its
 * manifest as `change` makes it, under the hash every pin reads it by.
 */
const publishedBefore = async (change: (manifest: string) => string) => {
  const old = await sealedWorkflow();
  const row = await env.DB.prepare(
    "SELECT manifest FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
  )
    .bind(old.workflow.id)
    .first<{ manifest: string }>();
  const manifest = change(row?.manifest ?? "");
  await env.DB.batch([
    env.DB.prepare("DROP TRIGGER workflow_resource_versions_immutable_update"),
    env.DB.prepare(
      "UPDATE workflow_resource_versions SET manifest = ?, manifest_hash = ? WHERE workflow_resource_id = ? AND version = 1"
    ).bind(manifest, await sha256Hex(manifest), old.workflow.id),
    env.DB.prepare(
      "CREATE TRIGGER workflow_resource_versions_immutable_update BEFORE UPDATE ON workflow_resource_versions BEGIN SELECT RAISE(ABORT, 'workflow_resource_versions are immutable'); END"
    ),
  ]);
  return old;
};

/** The code a start of version 1 of `old`'s workflow is refused with. */
const startOfFirst = async (old: Sealed): Promise<unknown> =>
  await codeOf(
    async () =>
      await startWorkflow(
        serving,
        { type: "person", person: old.by },
        old.workflow.id,
        { version: 1, input: { who: "Ada" }, key: unique() }
      )
  );

/** A manifest that also binds an App's store operation, as workflows could before. */
const withOperationBinding = (manifest: string): string => {
  const parsed = z
    .looseObject({ bindings: z.array(z.json()) })
    .parse(JSON.parse(manifest));
  return JSON.stringify({
    ...parsed,
    bindings: [
      ...parsed.bindings,
      {
        alias: "save",
        kind: "operation",
        contractId: "requests.add",
        fingerprint: "0".repeat(64),
      },
    ],
  });
};

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
    const start = await sealedRunStart(env, run);
    expect({
      frozen: Object.keys(run.params),
      handed: start.params,
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
      retried: failedWith("function.deadline_exceeded"),
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

  it("loads a published build's own module, generated onto the run host's SDK", async () => {
    const run = await sealedRunOf(await waitingRun(sealed));
    expect(sealedRunModules(run)[generatedModule]).toBe(
      run.build.modules[generatedModule]
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
      await artifactKey(artifact?.sha256 ?? ""),
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

  it("refuses a build an earlier generator made before any run of it starts, as one to publish again", async () => {
    // Sealed with the SDK of generator 1, whose decisions the run host's
    // engine no longer runs.
    const older = await publishedBefore((manifest) => {
      const changed = manifest.replace(
        `"generator":${JSON.stringify(generatorVersion)}`,
        '"generator":"grasp-workflow-ts/1"'
      );
      expect(changed).not.toBe(manifest);
      return changed;
    });
    const runs = async () =>
      await env.DB.prepare(
        "SELECT COUNT(*) AS runs FROM workflow_resource_runs WHERE workflow_resource_id = ?"
      )
        .bind(older.workflow.id)
        .first<{ runs: number }>();
    expect({
      start: await startOfFirst(older),
      runs: await runs(),
    }).toStrictEqual({
      start: "workflow.format_unsupported",
      runs: { runs: 0 },
    });
  });

  it("refuses a version an earlier platform release built, or binding a kind no longer served, as one to publish again, not as one changed", async () => {
    // As a version published while builds named a protocol.
    const earlier = await publishedBefore((manifest) =>
      manifest.replace('"build":{', '"build":{"protocol":9,')
    );
    await expect(startOfFirst(earlier)).resolves.toBe(
      "workflow.format_unsupported"
    );
    const operation = await publishedBefore(withOperationBinding);
    const { workflow, by } = operation;
    // A new version beside it, published as any is.
    const first = await env.DB.prepare(
      "SELECT definition FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
    )
      .bind(workflow.id)
      .first<{ definition: string }>();
    const definition = z
      .looseObject({ output: z.looseObject({ value: z.json() }) })
      .parse(JSON.parse(first?.definition ?? "{}"));
    await publishWorkflowVersion(env, by, workflow.id, {
      definition: JSON.stringify({
        ...definition,
        output: { ...definition.output, value: { status: "done again" } },
      }),
      basedOn: 1,
    });
    const listed = await workflowVersions(env, by, workflow.id);
    expect({
      start: await startOfFirst(operation),
      exported: await codeOf(
        async () => await exportedWorkflowVersion(env, by, workflow.id, 1)
      ),
      // Listed beside the new one, refused, never failing the listing.
      listed: listed.map(({ version, refused, build, actions }) => ({
        version,
        refused: refused?.code,
        told: refused?.message.includes("publish the workflow again"),
        built: build !== null,
        actions: actions.length,
      })),
    }).toStrictEqual({
      start: "workflow.binding_kind_removed",
      exported: "workflow.binding_kind_removed",
      listed: [
        {
          version: 2,
          refused: undefined,
          told: undefined,
          built: true,
          actions: 0,
        },
        {
          version: 1,
          refused: "workflow.binding_kind_removed",
          told: true,
          built: false,
          actions: 0,
        },
      ],
    });
  });
});

/** Task `id`'s own step, recording `record`, with `options` besides. */
const taskStep = (id: string, record: string, options = ""): string =>
  `await step.do(${JSON.stringify(id)}, { key: "task", description: "Its task"${options} }, async () => (${record}))`;

/** `levels` lists around a text, as a module's expression. */
const nestedIn = (levels: number): string =>
  `Array.from({ length: ${levels} }).reduce((inner) => [inner], "x")`;

/** Try `id`'s catch step, deciding by `takes`. */
const catchStep = (id: string, takes: string): string =>
  `await step.caught(${JSON.stringify(id)}, { key: "catch", description: "Its catch" }, ${takes})`;

/** The error `stop` raises, as a catch takes it. */
const stopped = {
  type: "urn:grasp:error:stop",
  status: 422,
  instance: "/steps/6/try/0/try/0",
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
            instance: "/steps/5/try/0",
            title: "Something went wrong.",
          },
        },
        tampered: [],
      },
    });
  });

  it("fails a call its run's data nests past 34 levels as its step's own failure, which a catch takes, and refuses a forged deep literal or slot", async () => {
    // Its `rows` slot is three levels into the arguments, so an
    // evaluation's result there, at most 32 deep, may nest them 35 levels
    // deep; its `who` slot is two levels in.
    const whoInput = { $expr: "args.who" };
    const deep = await sealedWorkflow([
      {
        id: "careful",
        type: "try",
        try: [
          {
            id: "ask",
            type: "generate",
            instructions: "Sum up.",
            input: { who: whoInput, rows: [whoInput] },
            returns: objectOf({ line: { kind: "string" } }),
          },
        ],
        catch: { errors: { type: `${standardErrors}validation` } },
      },
    ]);
    /** `ask`'s step, sending `instructions`, `who` and a row `levels` deep. */
    const ask = ({
      instructions = '"Sum up."',
      who = "args.who",
      levels = 1,
    }: {
      instructions?: string;
      who?: string;
      levels?: number;
    }) =>
      taskStep(
        "ask",
        `(async () => ({ output: await env.summary.call("grasp.model", { instructions: ${instructions}, input: { who: ${who}, rows: [${nestedIn(levels)}] } }) }))()`
      );
    const tooDeepRun = await waitingRun(deep);
    const tooDeep = await ranAs(
      tooDeepRun,
      moduleOf(`
try {
  return ${ask({ levels: valueDepth })};
} catch (thrown) {
  return { code: thrown.code, caught: (${catchStep("careful", "async () => true")}) ?? null };
}`)
    );
    // Each as deep as the `rows` slot may nest the arguments, so only
    // matching them against the sealed template tells them from the run's
    // data: a literal the build didn't seal, and a slot holding more than
    // an evaluation can answer.
    const forgedLiteral = await ranAs(
      await waitingRun(deep),
      moduleOf(`return ${ask({ instructions: nestedIn(valueDepth + 2) })};`)
    );
    const forgedSlot = await ranAs(
      await waitingRun(deep),
      moduleOf(`return ${ask({ who: nestedIn(valueDepth + 1) })};`)
    );
    const forgedDeeper = await ranAs(
      await waitingRun(deep),
      moduleOf(`return ${ask({ instructions: nestedIn(40) })};`)
    );
    expect({
      tooDeep,
      checked: await checkedCalls(tooDeepRun),
      forgedLiteral,
      forgedSlot,
      forgedDeeper,
    }).toStrictEqual({
      tooDeep: {
        ended: {
          code: "workflow.arguments_too_deep",
          caught: {
            type: `${standardErrors}validation`,
            status: 400,
            instance: anyText,
            title:
              "This step's arguments are nested deeper than 34 levels, so its call wasn't made.",
          },
        },
        tampered: [],
      },
      checked: [],
      forgedLiteral: refusedAs(
        "arguments.instructions isn't the value the build sealed."
      ),
      forgedSlot: refusedAs(
        "arguments.input.who nests deeper than an expression's result may."
      ),
      forgedDeeper: refusedAs(
        "A call sends its operation and JSON arguments within a step's size and the depth its build allows."
      ),
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
      thirdSteps: { decided: 2, ran: 2, timeout: 20_000 },
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
      resumed: { failed: "function.deadline_exceeded" },
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

/** A module of the test's own whose run on input `{ reviewer, invoice }` is `body`. */
const reviewModuleOf = (body: string): string => `
import { workflow, v } from ${sdkWorkflow};
export default workflow("sealed", { params: {}, input: v.object({ reviewer: v.string(), invoice: v.string() }) }, async (step, { input }) => {
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
 * outcome returned.
 */
const decideReview = (from = "entered.recipients[0]"): string => `
const decided = await step.decision("review", { key: "task", description: entered.prompt, from: ${from}, timeout: "365 days" });
return { decided };`;

/** How many times run `runId` asked the people of a decision, as audited. */
const asksAudited = async (runId: string): Promise<number> => {
  const events = await allEvents();
  return events.filter(
    ({ action, detail }) =>
      action === "workflow.decision.asked" && detail?.run === runId
  ).length;
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
const decide = (at) => step.decision("sign", { key: "task@" + at, description: "Approve this one", from: input.reviewer, timeout: "365 days" });
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
          await answerAs(reviewer, decision, {
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

  it("opens a decision only as its enter step recorded it, tells its code nobody's address, and refuses a step recording one it didn't open or a wait for another decision", async () => {
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
      told: await pastTheSdk(
        'const { decision } = await open(); return await engine.do("review:task#ask", {}, async () => await engine.askDecision(decision));'
      ),
      otherDecision: await pastTheSdk(
        `await open(); await engine.waitForDecision("review:task#answer", { decision: "${crypto.randomUUID()}", timeout: 1000, last: true }); return "waited";`
      ),
    }).toStrictEqual({
      otherFrom: refusedAs(
        'Task "review" opens its decision as its enter step recorded it.'
      ),
      unopened: refusedPastTheSdk("review:task"),
      told: { ended: undefined, tampered: [], refused: [] },
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
          await answerAs(reviewer, decision, { approved: false });
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
        await answerAs(reviewer, closed?.id ?? "", { approved: true });
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
        ended: { decided: { timedOut: true } },
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
            await answerAs(by, decision, { approved: true });
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
          await answerAs(builder, decision, { approved: true });
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
        ended: { decided: { timedOut: true } },
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
    // Code past the SDK whose ask step fails once its people were asked.
    const ran = await ranAs(
      runId,
      `export default { run: async (engine, input) => {
  await engine.do("review:enter", {}, async () => ({ recipients: [input.reviewer], prompt: "Approve the invoice", input: { invoice: input.invoice } }));
  const { decision } = await engine.do("review:task", {}, async () => await engine.openDecision({ step: "review:task", from: input.reviewer, description: "Approve the invoice", timeout: 1000 }));
  await engine.do("review:task#ask", {}, async () => { await engine.askDecision(decision); throw new Error("The mail server is down"); });
} };`,
      { engine: retryingEngine() }
    );
    expect({ ran, asked: await asksAudited(runId) }).toStrictEqual({
      ran: failedWith("workflow.failed_after_effect"),
      asked: 1,
    });
  });

  it("opens none of the organization's decisions, and tells nobody, for a test's run: a draft's or one an App's test started", async () => {
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
    // Its decision is kept with its test, or answered from its start's
    // fixtures (sealed-dispatch.test.ts): a run that only claims to be a
    // test's has neither, so it fails there, never reaching the
    // organization's decisions or anyone's inbox.
    expect({
      fixture: await run((frozen) => ({ ...frozen, fixture: true })),
      candidate: await run((frozen) => ({ ...frozen, candidate: new Map() })),
    }).toMatchObject({
      fixture: {
        ran: { ended: "function.cancelled" },
        decisions: [],
        asked: 0,
      },
      candidate: {
        ran: { ended: "workflow.call_denied" },
        decisions: [],
        asked: 0,
      },
    });
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
          await answerAs(reviewer, decision, { approved: true });
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
      replayed: first.ended,
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
            await answerAs(reviewer, open.id, {
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

/** Try `guard`'s catch in item `at` of `rows`, taking what it is offered. */
const guardAt = (at: string): string =>
  `await step.caught("guard", { key: "catch@" + ${at}, description: "Its catch" }, async () => true)`;

/** Step `finish`, after the loop. */
const finishStep =
  'await step.sleep("finish", { key: "task", description: "Its sleep", duration: 1000 })';

// A forged or miscompiled module's ways past a loop's items, each refused
// by the host (sealed-run.ts, `#loopRefusal` and `itemsUnfit`): a step
// the table doesn't have in items, or a key in another form; an item its
// loop's enter step never recorded, past its count, of a loop it never
// entered or skipped; items gone back to, reordered, run after the run
// left their loop, or run over by entering the loop again; a loop past the
// platform's 1,000 items; a step past a failure pending in an item; and a
// catch moving a failure on to the next item.
describe("a sealed run's loop items on the run host", () => {
  let sealed: Sealed;

  beforeAll(async () => {
    await connectModels(`test-model-key-${crypto.randomUUID()}`, [
      allowedModel,
    ]);
    sealed = await sealedWorkflow();
  });

  afterEach(endLiveResourceRuns);

  const run = async (body: string) =>
    await ranAs(await waitingRun(sealed), moduleOf(body));

  it("refuses a step in items the table doesn't have, and an item its loop never recorded", async () => {
    expect({
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
        await waitingRun(sealed),
        `export default { run: async (engine) => {
  await engine.do("rows:enter", {}, async () => ({ items: ["a"] }));
  try { await engine.do("check:task@0", {}, async () => ({ output: null })); return "ran"; } catch (error) { return error.code; }
} };`
      ),
    }).toStrictEqual({
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
    const inRows = async (body: string) =>
      await run(`${enterRows('["a", "b", "c"]')} const sent = []; ${body}`);
    expect({
      // Items whose work was all skipped run no step: the next goes on.
      emptyFirst: await inRows(`sent.push(${notifyAt("1")}); return sent;`),
      backAfterSkip: await inRows(
        `sent.push(${notifyAt("2")}); return ${notifyAt("1")};`
      ),
      reordered: await inRows(
        `sent.push(${notifyAt("0")}); sent.push(${notifyAt("1")}); return ${checkAt("0")};`
      ),
      afterLeaving: await inRows(
        `sent.push(${notifyAt("0")}); ${finishStep}; return ${notifyAt("1")};`
      ),
      // Past the SDK, which would refuse a name it ran: the loop entered
      // again to run its items over.
      enteredAgain: await ranAs(
        await waitingRun(sealed),
        `export default { run: async (engine) => {
  await engine.do("rows:enter", {}, async () => ({ items: ["a"] }));
  await engine.do(${JSON.stringify(engineStep("check", "task@0"))}, {}, async () => ({ skipped: true }));
  try { await engine.do("rows:enter", {}, async () => ({ items: ["a"] })); return "entered"; } catch (error) { return error.code; }
} };`
      ),
    }).toStrictEqual({
      emptyFirst: { ended: ["string"], tampered: [] },
      backAfterSkip: refusedAs(
        `Item 1 of loop "rows" doesn't run now: its items run in increasing order, each once.`
      ),
      reordered: refusedAs(
        `Item 0 of loop "rows" doesn't run now: its items run in increasing order, each once.`
      ),
      afterLeaving: refusedAs(`Loop "rows" has no item 1 here.`),
      enteredAgain: {
        ended: "workflow.invalid",
        tampered: ["workflow.invalid"],
      },
    });
  });

  it("holds a loop to 1,000 items, and each item's failure and catch to that item", async () => {
    expect({
      atMost: await run(
        `${enterRows("Array.from({ length: 1000 }, (_, at) => at)")} return items.length;`
      ),
      tooMany: await run(
        `${enterRows("Array.from({ length: 1001 }, (_, at) => at)")} return items.length;`
      ),
      notAList: await run(
        'await step.do("rows", { key: "enter", description: "Its items" }, async () => ({ output: ["a"] })); return "entered";'
      ),
      // Item 0's raise, swallowed: item 1 doesn't start.
      pastFailure: await run(
        `${enterRows('["a", "b"]')} const sent = []; sent.push(${notifyAt("0")}); try { ${checkAt("0")}; } catch {} return ${notifyAt("1")};`
      ),
      // Item 0's raise, offered to item 1's catch.
      otherCatch: await run(
        `${enterRows('["a", "b"]')} try { ${checkAt("0")}; } catch { return ${guardAt("1")}; }`
      ),
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
    });
  });
});
