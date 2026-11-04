import { checkWorkflow } from "@grasp-os/workflow-schema/check";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { generateWorkflow } from "@grasp-os/workflow-schema/generate";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { tasksFileSchema } from "../src/workflow-builds.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import type { HostedSealedRun } from "../src/workflows/sealed-run.ts";
import { endLiveResourceRuns } from "./json-workflow-apps.ts";
import { answeringProvider, connectModels } from "./model-provider.ts";
import {
  allowedModel,
  checkedCalls,
  hello,
  person,
  ranAs,
  retryingEngine,
  sdkWorkflow,
  sealedWorkflow,
  waitingRun,
} from "./sealed-run-harness.ts";
import type { Sealed } from "./sealed-run-harness.ts";
import { unique } from "./sign-in.ts";

/**
 * What an engine ran of try `guarded` around step `fail`, by `tries`:
 * the retry rounds its policy decided and ran, and whether the catch took
 * the failure and ran its `tell`.
 */
const guardedRan = (tries: ReadonlyMap<string, number>) => {
  const keys = [...tries.keys()];
  return {
    decided: keys.filter((key) => key.endsWith(":decide")).length,
    retried: keys.filter((key) => key.endsWith(":run")).length,
    failed: tries.get("key:fail:task"),
    caught: tries.has("key:guarded:catch"),
    told: tries.has("key:tell:task"),
  };
};

// grasp-workflow/1's generated code, run end to end on the run host
// (sealed-run.ts) with the sealed table its generator made: a real
// published workflow's run, its bindings approved and its sensitive token
// set, its build's module and table in place of the old generator's. So
// every step kind of the format runs as the host holds a sealed build to
// it, refused nothing as tampering: the calls go out as sealed, the
// sensitive value put in by the host, the model asked, the waits slept,
// the `if` taken, the raise failing its step and the catch taking it.

/** The bindings and the sensitive token of `sealedWorkflow`'s workflow. */
const declared = {
  params: {
    token: { kind: "text", label: "Token", sensitive: true },
  },
  bindings: {
    mail: { kind: "connector", contract: "composio.mail@1" },
    summary: { kind: "model", contract: "summary" },
  },
};

const greeting = {
  type: "object",
  properties: { line: { type: "string" } },
  required: ["line"],
  additionalProperties: false,
};

/** An object schema of `properties`, every one required. */
const objectOf = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/**
 * `steps` and their `output` (its schema and value), generated: the
 * module, and the run with its table.
 */
const generated = (
  steps: unknown[],
  output?: { schema: unknown; value: unknown },
  bindings: Record<string, unknown> = declared.bindings
) => {
  const result = checkWorkflow({
    $schema: "https://grasp.work/schemas/grasp-workflow/1.json",
    params: declared.params,
    bindings,
    ...(output === undefined ? {} : { output }),
    steps,
  });
  if (!result.ok) {
    throw new Error(`Not a valid workflow: ${JSON.stringify(result.problems)}`);
  }
  const generation = generateWorkflow(result.workflow, "sealed");
  // The table as core seals it (tasks.json): its own schema reads it.
  const table = tasksFileSchema.parse(
    structuredClone({
      tasks: generation.tasks,
      expressions: generation.expressions,
      workflow: generation.workflow,
      params: generation.params,
      limits: generation.limits,
    })
  );
  return {
    // The workflow SDK by the flat name the sealed build has it.
    source: generation.source.replace('"@grasp-os/sdk/workflow"', sdkWorkflow),
    sealed: (run: HostedSealedRun): HostedSealedRun => ({
      ...run,
      build: { ...run.build, ...table },
    }),
  };
};

describe("a grasp-workflow/1 workflow's generated code on the run host", () => {
  let sealed: Sealed;

  beforeAll(async () => {
    await connectModels(`test-model-key-${crypto.randomUUID()}`, [
      allowedModel,
    ]);
    sealed = await sealedWorkflow();
  });

  afterAll(endLiveResourceRuns);

  it("runs a wait, a connector call, an agent, an if and a try as sealed, refusing nothing", async () => {
    await answeringProvider(() => hello, { models: [allowedModel] });
    const { source, sealed: withTable } = generated(
      [
        { id: "linger", type: "wait", for: "1 hour" },
        {
          id: "send",
          type: "do",
          binding: "mail",
          operation: "mail.send",
          arguments: {
            to: { $expr: "input.who" },
            subject: { $expr: "params.token" },
          },
        },
        {
          id: "greet",
          type: "agent",
          binding: "summary",
          instructions: "Greet them.",
          input: { who: { $expr: "input.who" } },
          output: greeting,
        },
        {
          id: "known",
          type: "if",
          condition: { $expr: 'steps.greet.output.line === "Hello Ada"' },
          // oxlint-disable-next-line unicorn/no-thenable -- the if step's list
          then: [{ id: "pause", type: "wait", until: { $expr: "0" } }],
          else: [
            {
              id: "stop",
              type: "raise",
              error: { type: "urn:grasp:error:stop", status: 422 },
            },
          ],
        },
        {
          id: "guarded",
          type: "try",
          try: [
            {
              id: "fetch",
              type: "do",
              binding: "mail",
              operation: "mail.send",
              arguments: { to: { $expr: "input.who" }, subject: "x" },
            },
          ],
          catch: {
            errors: { status: 500 },
            retry: { attempts: 3, delay: "1 second", backoff: "constant" },
          },
        },
      ],
      {
        schema: objectOf({
          line: { type: "string" },
          sent: { type: "string" },
        }),
        value: {
          line: { $expr: "steps.greet.output.line" },
          sent: { $expr: "typeof steps.send.output.messageId" },
        },
      }
    );
    const runId = await waitingRun(sealed);
    const ran = await ranAs(runId, source, {
      engine: retryingEngine(),
      sealed: withTable,
    });
    const { sent } = await sealed.mail.did();
    const checked = await checkedCalls(runId);
    expect({
      ran,
      sent,
      checked: checked.map(({ step, call, binding }) => ({
        step,
        call,
        binding,
      })),
    }).toStrictEqual({
      ran: {
        ended: { line: "Hello Ada", sent: "string" },
        tampered: [],
      },
      sent: [
        { to: "Ada", subject: sealed.secret },
        { to: "Ada", subject: "x" },
      ],
      checked: [
        { step: "send:task", call: "grasp.connector", binding: "mail" },
        { step: "greet:task", call: "grasp.model", binding: "summary" },
        { step: "fetch:task", call: "grasp.connector", binding: "mail" },
      ],
    });
  });

  it("fails a raise with its sealed error, which its catch takes, and skips a step whose `if` doesn't hold", async () => {
    const { source, sealed: withTable } = generated(
      [
        {
          id: "skipped",
          type: "do",
          if: { $expr: 'input.who === "Bob"' },
          binding: "mail",
          operation: "mail.send",
          arguments: { to: "bob", subject: "never" },
        },
        {
          id: "unraised",
          type: "raise",
          if: { $expr: 'input.who === "Bob"' },
          error: { type: "urn:grasp:error:bob", status: 409 },
        },
        {
          id: "guarded",
          type: "try",
          try: [
            {
              id: "stop",
              type: "raise",
              error: {
                type: "urn:grasp:error:stop",
                status: 422,
                title: "Stopped.",
              },
            },
          ],
          catch: {
            errors: { status: 422 },
            do: [
              {
                id: "notice",
                type: "do",
                binding: "mail",
                operation: "mail.send",
                arguments: {
                  to: { $expr: "input.who" },
                  subject: { $expr: "error.type" },
                },
              },
            ],
          },
        },
      ],
      {
        schema: objectOf({ skipped: { type: "boolean" } }),
        value: { skipped: { $expr: "steps.skipped.output === null" } },
      }
    );
    const ran = await ranAs(await waitingRun(sealed), source, {
      engine: retryingEngine(),
      sealed: withTable,
    });
    const { sent } = await sealed.mail.did();
    expect({ ran, notice: sent.at(-1) }).toStrictEqual({
      ran: { ended: { skipped: true }, tampered: [] },
      notice: { to: "Ada", subject: "urn:grasp:error:stop" },
    });
  });

  it("fails the run with a raise no catch takes", async () => {
    const { source, sealed: withTable } = generated([
      {
        id: "stop",
        type: "raise",
        error: { type: "urn:grasp:error:stop", status: 422 },
      },
    ]);
    const ran = await ranAs(await waitingRun(sealed), source, {
      engine: retryingEngine(),
      sealed: withTable,
    });
    expect({ ended: ran.ended, tampered: ran.tampered }).toStrictEqual({
      ended: "workflow.raised",
      tampered: [],
    });
  });
});

/** A module of calculations: `total` sums, `broken` always fails. */
const totalModule = `import { compute, v } from "@grasp-os/sdk/compute";

export const total = compute({
  input: v.array(v.number()).max(100),
  output: v.number(),
  handler: (amounts) => amounts.reduce((all, amount) => all + amount, 0),
});

export const broken = compute({
  input: v.number(),
  output: v.number(),
  handler: () => {
    throw new Error("Never adds up");
  },
});
`;

/** An action that answers whom it noted, reaching nothing. */
const noteModule = `import { action, v } from "@grasp-os/sdk/action";

export const note = action({
  args: { to: v.string() },
  returns: v.object({ status: v.string() }),
  uses: [],
  handler: async (_ctx, { to }) => ({ status: \`noted \${to}\` }),
});
`;

/** The bindings of `localWorkflow`'s workflow, as grasp-workflow/1 declares them. */
const local = {
  total: { kind: "compute", contract: "local:code/total.ts#total" },
  broken: { kind: "compute", contract: "local:code/total.ts#broken" },
  note: { kind: "action", contract: "local:code/note.ts#note" },
};

/**
 * A workflow of a builder's whose bindings reach its own modules, compute
 * `total` and `broken` and action `note`, published with them: after an
 * hour's wait, it calls each.
 */
const localWorkflow = async () => {
  const by = await person("builder");
  const workflow = await createWorkflowResource(env, by, `local-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: JSON.stringify({
      $schema: workflowSchemaUrl,
      input: objectOf({ who: { type: "string" } }),
      output: {
        schema: objectOf({ status: { type: "string" } }),
        value: { status: "done" },
      },
      bindings: local,
      steps: [
        { id: "linger", type: "wait", for: "1 hour" },
        { id: "add", type: "do", binding: "total", arguments: [1, 2, 3] },
        { id: "fail", type: "do", binding: "broken", arguments: 1 },
        {
          id: "tell",
          type: "do",
          binding: "note",
          arguments: { to: { $expr: "input.who" } },
        },
      ],
    }),
    basedOn: null,
    modules: { "code/total.ts": totalModule, "code/note.ts": noteModule },
  });
  return { by, workflow };
};

describe("a grasp-workflow/1 workflow's own modules on the run host", () => {
  let owned: Awaited<ReturnType<typeof localWorkflow>>;

  beforeAll(async () => {
    owned = await localWorkflow();
  });

  afterAll(endLiveResourceRuns);

  it("calls a compute and an action binding as sealed, refusing none", async () => {
    const { source, sealed: withTable } = generated(
      [
        { id: "linger", type: "wait", for: "1 hour" },
        {
          id: "add",
          type: "do",
          binding: "total",
          arguments: [1, { $expr: "input.who.length" }, 3],
        },
        {
          id: "tell",
          type: "do",
          binding: "note",
          arguments: { to: { $expr: "input.who" } },
        },
      ],
      {
        schema: objectOf({
          total: { type: "number" },
          told: { type: "string" },
        }),
        value: {
          total: { $expr: "steps.add.output" },
          told: { $expr: "steps.tell.output.status" },
        },
      },
      local
    );
    const runId = await waitingRun(owned);
    const ran = await ranAs(runId, source, {
      engine: retryingEngine(),
      sealed: withTable,
    });
    const checked = await checkedCalls(runId);
    expect({
      ran,
      checked: checked.map(({ step, call, binding }) => ({
        step,
        call,
        binding,
      })),
    }).toStrictEqual({
      // Ada's name is 3 long.
      ran: {
        ended: { total: 7, told: "noted Ada" },
        tampered: [],
      },
      checked: [
        { step: "add:task", call: "grasp.compute", binding: "total" },
        { step: "tell:task", call: "grasp.action", binding: "note" },
      ],
    });
  });

  it("decides a catch's and a retry's `when` as booleans, retrying while the retry's holds", async () => {
    const tries = new Map<string, number>();
    const { source, sealed: withTable } = generated(
      [
        {
          id: "guarded",
          type: "try",
          try: [{ id: "fail", type: "do", binding: "broken", arguments: 1 }],
          catch: {
            when: { $expr: "error.status >= 400" },
            retry: {
              attempts: 3,
              delay: "1 second",
              backoff: "constant",
              // A number: the choice the host reads takes a boolean.
              when: { $expr: "error.status" },
            },
            do: [
              {
                id: "tell",
                type: "do",
                binding: "note",
                arguments: { to: { $expr: "error.type" } },
              },
            ],
          },
        },
      ],
      undefined,
      local
    );
    const ran = await ranAs(await waitingRun(owned), source, {
      engine: retryingEngine(tries),
      sealed: withTable,
    });
    expect({ ran, guarded: guardedRan(tries) }).toStrictEqual({
      ran: { ended: null, tampered: [] },
      // Rounds 2 and 3 of its 3 attempts, each decided, then caught.
      guarded: {
        decided: 2,
        retried: 2,
        failed: 1,
        caught: true,
        told: true,
      },
    });
  });

  it("takes a retry `when` that throws as not retrying, the failure recorded and caught", async () => {
    const tries = new Map<string, number>();
    const { source, sealed: withTable } = generated(
      [
        {
          id: "guarded",
          type: "try",
          try: [{ id: "fail", type: "do", binding: "broken", arguments: 1 }],
          catch: {
            retry: {
              attempts: 3,
              delay: "1 second",
              backoff: "constant",
              // Reads past a field that isn't there: it throws.
              when: { $expr: "error.missing.deeper === 1" },
            },
            do: [
              {
                id: "tell",
                type: "do",
                binding: "note",
                arguments: { to: { $expr: "error.type" } },
              },
            ],
          },
        },
      ],
      undefined,
      local
    );
    const ran = await ranAs(await waitingRun(owned), source, {
      engine: retryingEngine(tries),
      sealed: withTable,
    });
    expect({ ran, guarded: guardedRan(tries) }).toStrictEqual({
      ran: { ended: null, tampered: [] },
      // Its decision failed: no round runs, and the failure is the
      // step's own, which the catch takes.
      guarded: {
        decided: 1,
        retried: 0,
        failed: 1,
        caught: true,
        told: true,
      },
    });
  });
});
