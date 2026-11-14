import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
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
  versionContract,
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
  failedWith,
  greet,
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
  sealedRunOf,
  sealedWorkflow,
  seenOfCall,
  send,
  serving,
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
import { failingStep, taskStep } from "./sealed-runs.ts";
import { unique } from "./sign-in.ts";
import { publishDefinition } from "./workflow-publishing.ts";

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
 * manifest as `change` makes it, and its contract as `changeContract`
 * does, each under the hash every pin reads it by.
 */
const publishedBefore = async (
  change: (manifest: string) => string,
  changeContract: (contract: string) => string = (contract) => contract
) => {
  const old = await sealedWorkflow();
  const row = await env.DB.prepare(
    "SELECT manifest, contract FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
  )
    .bind(old.workflow.id)
    .first<{ manifest: string; contract: string }>();
  const manifest = change(row?.manifest ?? "");
  const contract = changeContract(row?.contract ?? "");
  await env.DB.batch([
    env.DB.prepare("DROP TRIGGER workflow_resource_versions_immutable_update"),
    env.DB.prepare(
      "UPDATE workflow_resource_versions SET manifest = ?, manifest_hash = ?, contract = ?, contract_hash = ? WHERE workflow_resource_id = ? AND version = 1"
    ).bind(
      manifest,
      await sha256Hex(manifest),
      contract,
      await sha256Hex(contract),
      old.workflow.id
    ),
    env.DB.prepare(
      // Back as migration 0247 left it: only a version's label changes.
      "CREATE TRIGGER workflow_resource_versions_immutable_update BEFORE UPDATE OF workflow_resource_id, version, definition_version, definition, definition_json_hash, profile_version, evaluator_hash, contract, contract_hash, manifest, manifest_hash, author_id, created_at, seal_id ON workflow_resource_versions BEGIN SELECT RAISE(ABORT, 'workflow_resource_versions are immutable'); END"
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
        { expected: 1, args: { who: "Ada" }, key: unique() }
      )
  );

/** A manifest of format 1, as releases before format 2 sealed one. */
const ofFormat1 = (manifest: string): string =>
  JSON.stringify({
    ...z.looseObject({}).parse(JSON.parse(manifest)),
    formatVersion: 1,
  });

/** A contract as format 1 stored it: its `args` and `returns` as `input` and `output`. */
const contractOfFormat1 = (contract: string): string => {
  const { args, returns, ...rest } = z
    .looseObject({ args: z.json(), returns: z.json() })
    .parse(JSON.parse(contract));
  return JSON.stringify({ ...rest, input: args, output: returns });
};

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

// A sealed run's decisions (`grasp.decision`), from the threat model in
// sealed-run.ts: deciders forged by the isolate, an answer forged or
// taken from the run's own person, a wait for another decision or cut
// short, an answer after the deadline, and a replay asking again.

/** A module of the test's own whose run on input `{ reviewer, invoice }` is `body`. */
const reviewModuleOf = (body: string): string => moduleOf(body);

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
 * `ask(at)` and `decide(at)` of task `sign` in its run `at`.
 */
const signed = (body: string): string => `
const items = ["INV-1", "INV-2"];
const ask = (at) => step.do("sign", { key: "enter@" + at, description: "Its ask" }, async () => ({ recipients: [input.reviewer], prompt: "Approve this one", input: { invoice: items[at] } }));
const decide = (at) => step.decision("sign", { key: "task@" + at, description: "Approve this one", from: input.reviewer, timeout: "365 days" });
${body}`;

/** Task `notify`'s call in its run `at`, mailing `to`. */
const notifyAt = (at: string, to = '"a"'): string =>
  `await step.do("notify", { key: "task@" + ${at}, description: "Its task" }, async () => typeof (await env.mail.call("mail.send", { to: ${to}, subject: "loop" })).messageId)`;

/** Step `finish`, after the loop. */
const finishStep =
  'await step.sleep("finish", { key: "task", description: "Its sleep", duration: 1000 })';

/** `send`'s mail, its call naming the files permissions `files` (code). */
const mailNaming = (files: string): string =>
  moduleOf(
    send(
      `return await env.mail.call("mail.send", { to: input.who, subject: sensitiveParam("token") }, ${files});`
    )
  );

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
          'return await env.ai.call("mail.send", { to: input.who, subject: sensitiveParam("token") });'
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

  it("refuses a call naming files permissions its build doesn't: a file kept or run files attached of the isolate's own choosing", async () => {
    // A workflow of its own: its waiting runs count toward no other test's.
    const own = await sealedWorkflow();
    const ranNaming = async (files: string) => {
      const runId = await waitingRun(own);
      const { ended, tampered } = await ranAs(runId, mailNaming(files));
      return { ended, tampered, checked: await checkedCalls(runId) };
    };
    // Refused as tampering before it is checked or made.
    const refused = {
      ended: "workflow.invalid",
      tampered: ["workflow.invalid"],
      checked: [],
    };
    expect({
      into: await ranNaming('{ into: "files" }'),
      from: await ranNaming('{ from: "files" }'),
    }).toStrictEqual({ into: refused, from: refused });
  });

  it("keeps no file from a read passing a sensitive parameter, even one its build says keeps it", async () => {
    const own = await sealedWorkflow();
    const runId = await waitingRun(own);
    // A table no check lets through: its mail, which passes the sensitive
    // token, keeps its answer as a file.
    const { ended, tampered } = await ranAs(
      runId,
      mailNaming('{ into: "files" }'),
      {
        sealed: (loaded) => ({
          ...loaded,
          build: {
            ...loaded.build,
            tasks: loaded.build.tasks.map((task) =>
              task.kind === "call" && task.call.name === "grasp.connector"
                ? { ...task, call: { ...task.call, into: "files" } }
                : task
            ),
          },
        }),
      }
    );
    const events = await allEvents();
    expect({
      ended,
      tampered,
      made: events.filter(
        ({ action, target }) =>
          action === "workflow.run.called" && target?.id === runId
      ),
    }).toStrictEqual({
      ended: "workflow.call_invalid",
      tampered: [],
      made: [],
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
        `return await step.do("greet", { key: "task", description: "Its task", retries: { limit: 2 } }, async () => await env.ai.call("grasp.model", ${greeting}));`
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
        `return await step.do("greet", { key: "task", description: "Its task", retries: { limit: 2 } }, async () => await env.ai.call("grasp.model", ${greeting}));`
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
      { expected: 1, args: { who: "Ada" }, key: unique() }
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

  it("refuses a version an earlier platform release built, or sealed in an earlier format, as one to publish again, not as one changed", async () => {
    // As a version published while builds named a protocol.
    const earlier = await publishedBefore((manifest) =>
      manifest.replace('"build":{', '"build":{"protocol":9,')
    );
    await expect(startOfFirst(earlier)).resolves.toBe(
      "workflow.format_unsupported"
    );
    // As a version published before format 2, its contract as it stored it.
    const format1 = await publishedBefore(ofFormat1, contractOfFormat1);
    const { workflow, by } = format1;
    const start = await startOfFirst(format1);
    // A new version beside it, published as any is.
    const first = await env.DB.prepare(
      "SELECT definition FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
    )
      .bind(workflow.id)
      .first<{ definition: string }>();
    const definition = z
      .looseObject({ result: z.json() })
      .parse(JSON.parse(first?.definition ?? "{}"));
    await publishDefinition(
      env,
      by,
      workflow.id,
      JSON.stringify({
        ...definition,
        result: { status: "done again" },
      })
    );
    const listed = await workflowVersions(env, by, workflow.id);
    expect({
      start,
      exported: await codeOf(
        async () => await exportedWorkflowVersion(env, by, workflow.id, 1)
      ),
      contract: await codeOf(
        async () => await versionContract(env, workflow.id, 1)
      ),
      // Listed beside the new one, refused, never failing the listing.
      listed: listed.map(({ version, refused, build }) => ({
        version,
        refused: refused?.code,
        told: refused?.message.includes("Publish it again"),
        built: build !== null,
      })),
    }).toStrictEqual({
      start: "workflow.format_unsupported",
      exported: "workflow.format_unsupported",
      contract: "workflow.format_unsupported",
      listed: [
        {
          version: 2,
          refused: undefined,
          told: undefined,
          built: true,
        },
        {
          version: 1,
          refused: "workflow.format_unsupported",
          told: true,
          built: false,
        },
      ],
    });
  });
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
      `const { line } = ${taskStep("greet", `await env.ai.call("grasp.model", ${greeting})`)}; return { status: line };`
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
        `const { line } = ${taskStep("greet", `await env.ai.call("grasp.model", ${greeting})`)}; return { status: line };`
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
const { line } = ${taskStep("again", `await env.ai.call("grasp.model", ${greeting})`)};
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

  it("fails a run whose code ends well past a failure no catch may take with that failure, as its code rethrowing it does, and with a raise only as its build seals it", async () => {
    const run = async (body: string) =>
      await activated(
        await waitingRun(sealed),
        moduleOf(body),
        activationEngine(new Map())
      );
    const failing = failingStep("send");
    expect({
      swallowed: await run(
        `try { ${failing}; } catch {} return { status: "done" };`
      ),
      rethrown: await run(
        `try { ${failing}; } catch (thrown) { throw thrown; } return { status: "done" };`
      ),
      raised: await run('throw new AppError("test.stop", "Not its words.");'),
      notRaised: await run('throw new AppError("test.other", "Not sealed.");'),
      ended: await run('return { status: "done" };'),
    }).toStrictEqual({
      swallowed: { failed: "workflow.task_data_invalid" },
      rethrown: { failed: "workflow.task_data_invalid" },
      raised: { failed: "test.stop" },
      notRaised: { failed: anyText },
      ended: { status: "done" },
    });
  });
});

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
    // Run 1 opens its decision without its own ask: run 0's isn't its.
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
          step: "sign:task",
          input: { invoice: "INV-1" },
          status: "approved",
        },
        {
          step: "sign:task@1",
          input: { invoice: "INV-2" },
          status: "rejected",
        },
      ],
      otherAsk: refusedAs(
        'Run 1 of task "sign" doesn\'t run now: its runs go in increasing order, each once.'
      ),
    });
  });
});

// A forged or miscompiled module's ways past a task's runs in a loop's
// items, each refused by the host (sealed-run.ts, `#runRefusal`): a count
// on a task in no loop, or in another form; a run skipped, repeated or
// gone back to; a step of a loop of its own; and a step past a failure
// pending in a run whose task no try takes it around.
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

  it("runs a task inside a loop's items once a run, in order, and a task in no loop once", async () => {
    expect({
      inOrder: await run(
        `const sent = []; for (let at = 0; at < 3; at += 1) sent.push(${notifyAt("at")}); ${finishStep}; return sent;`
      ),
      skipped: await run(
        `const sent = []; sent.push(${notifyAt("0")}); return ${notifyAt("2")};`
      ),
      again: await run(
        `const sent = []; sent.push(${notifyAt("0")}); return ${notifyAt("0")};`
      ),
      backAgain: await run(
        `const sent = []; sent.push(${notifyAt("0")}); sent.push(${notifyAt("1")}); return ${notifyAt("0")};`
      ),
      outsideLoop: await run(
        `return await step.do("send", { key: "task@1", description: "Its task" }, async () => null);`
      ),
      leadingZero: await run(
        `const sent = []; sent.push(${notifyAt("0")}); return await step.do("notify", { key: "task@01", description: "Its task" }, async () => null);`
      ),
      loopStep: await run(
        `return await step.do("rows", { key: "enter", description: "Its items" }, async () => ({ items: ["a"] }));`
      ),
    }).toStrictEqual({
      inOrder: { ended: ["string", "string", "string"], tampered: [] },
      skipped: refusedAs(
        'Run 2 of task "notify" doesn\'t run now: its runs go in increasing order, each once.'
      ),
      again: refusedAs(`Step "notify:task" runs once.`),
      backAgain: refusedAs(`Step "notify:task" runs once.`),
      outsideLoop: refusedAs(`Step "send:task@1" isn't one the build seals.`),
      leadingZero: refusedAs(
        `Step "notify:task@01" isn't one the build seals.`
      ),
      loopStep: refusedAs(`Step "rows:enter" isn't one the build seals.`),
    });
  });

  it("holds a run's failure to the tries around its task", async () => {
    expect({
      // `notify` is in no try: its run 0's failure, swallowed, holds run 1 back.
      pastFailure: await run(
        `try { await step.do("notify", { key: "task", description: "Its task" }, async () => { throw new Error("down"); }); } catch {} return ${notifyAt("1")};`
      ),
    }).toStrictEqual({
      pastFailure: refusedAs(
        "A run goes on past a failure only where a catch around its step takes it."
      ),
    });
  });
});
