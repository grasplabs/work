import { appModuleName, generatedWorkflowEntry } from "@grasp-os/compiler";
import { v } from "@grasp-os/sdk";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { workflowErrors } from "@grasp-os/shared/workflows";
import { decode } from "@grasp-os/workerflow/codec";
import { checkWorkflow } from "@grasp-os/workflow-schema/check";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { generateWorkflow } from "@grasp-os/workflow-schema/generate";
import { sealedTableSchema } from "@grasp-os/workflow-schema/sealed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { buildGeneratedWorkflow } from "../src/pages.ts";
import { releaseContracts } from "../src/release-contracts.ts";
import {
  approveWorkflowBinding,
  revokeWorkflowBinding,
} from "../src/workflow-bindings.ts";
import {
  ensureReleaseContract,
  publishCatalogContract,
} from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { runEngine } from "../src/workflows/engine.ts";
import { eventTypeKey } from "../src/workflows/event-envelopes.ts";
import { countedStep } from "../src/workflows/host.ts";
import { admitRunEvent } from "../src/workflows/run-events.ts";
import type { HostedSealedRun } from "../src/workflows/sealed-run.ts";
import { allEvents } from "./audit-events.ts";
import { endLiveResourceRuns } from "./json-workflow-apps.ts";
import { answeringProvider, connectModels } from "./model-provider.ts";
import {
  allowedModel,
  answerAs,
  checkedCalls,
  codeOf,
  deadlinePasses,
  decidingEngine,
  decisionsOf,
  decisionWorkflow,
  descriptorOf,
  echoingMail,
  failedWith,
  hello,
  journalingEngine,
  newerEngine,
  person,
  ranAs,
  retryingEngine,
  reviewRun,
  sealedRunOf,
  sealedWorkflow,
  waitingRun,
} from "./sealed-run-harness.ts";
import type {
  Engine,
  Journaled,
  Reviewed,
  Sealed,
} from "./sealed-run-harness.ts";
import { refusal, unique } from "./sign-in.ts";

/**
 * `engine`, its activation evicted as step `name` was to start: nothing
 * of that step or after it journaled, as a later activation finds it.
 */
const evictedBefore = (engine: Engine, name: string): Engine => ({
  leaseOf: engine.leaseOf,
  step: {
    ...engine.step,
    do: async (step, config, fn) => {
      if (step === name) {
        throw new Error("The activation was evicted");
      }
      return await engine.step.do(step, config, fn);
    },
  },
});

/**
 * What an engine ran of try `guarded` around step `fail`, by `tries`:
 * the retry rounds its policy decided and ran, and whether the catch took
 * the failure and ran its `tell`.
 */
const guardedRan = (tries: ReadonlyMap<string, number>) => {
  const keys = [...tries.keys()];
  // In a loop's items, a task's later runs go on with their count.
  const of = (step: string): string | undefined =>
    keys.find((key) => key === step || key.startsWith(`${step}@`));
  return {
    decided: keys.filter((key) => key.endsWith(":decide")).length,
    retried: keys.filter((key) => key.endsWith(":run")).length,
    failed: tries.get(of("key:fail:task") ?? ""),
    // Its catch ran its `do`: it took the failure.
    told: of("key:tell:task") !== undefined,
  };
};

// grasp-workflow/2's generated code, run end to end on the run host
// (sealed-run.ts) with the sealed table its generator made: a real
// published workflow's run, its bindings approved and its sensitive token
// set, its build's module and table in place of the old generator's. So
// every step kind of the format runs as the host holds a sealed build to
// it, refused nothing as tampering: the calls go out as sealed, the
// sensitive value put in by the host, the model asked, the waits slept,
// the `if` taken, the raise failing the run and the catch taking it.

/** The permissions and the sensitive token of `sealedWorkflow`'s workflow. */
const declared = {
  params: {
    token: { label: "Token", type: { kind: "string" }, sensitive: true },
  },
  permissions: {
    connections: { mail: { contract: "composio.mail@1" } },
    ai: { contract: "summary" },
  },
  /** What the workflow keeps between runs: what the state tests write. */
  state: {
    last: { kind: "string" },
    previous: { kind: "string" },
    runs: { kind: "number", integer: true, min: 1 },
    kind: { kind: "string" },
    never: { kind: "boolean" },
    who: { kind: "person" },
    profile: { kind: "object", fields: { id: { kind: "string" } } },
    // An object whose field has a default: `{}` fits it.
    badge: {
      kind: "object",
      fields: { label: { kind: "string", default: "unknown" } },
    },
  },
};

const greeting = { kind: "object", fields: { line: { kind: "string" } } };

/** Step `id` calling `action` of `mail`, in a try that takes any failure. */
const calling = (id: string, action: string) => ({
  id: `${id}Tried`,
  type: "try",
  try: [{ id, type: "call", connection: "mail", action, args: {} }],
  catch: {},
});

/** An object of `fields`, every one required. */
const objectOf = (fields: Record<string, unknown>) => ({
  kind: "object",
  fields,
});

/** The input `sealedWorkflow`'s runs start with: whom to greet. */
const greeted = objectOf({ who: { kind: "string" } });

/** An input of `rows`, each an `item`: what a loop's tests give a run. */
const rowsOf = (item: unknown) => objectOf({ rows: { kind: "array", item } });

/** Where a build of the generated module keeps it: as the host's own. */
const generatedPath = generatedWorkflowEntry;

/**
 * `steps` and their `output` (its schema and value), generated: the
 * module, built as the host's generated workflow is (type-checked against the SDK,
 * its types stripped, its imports by their flat names), and the run with
 * its table. The module takes `input`, as its run is given it.
 */
const generated = async (
  steps: unknown[],
  output?: { schema: unknown; value: unknown },
  permissions: Record<string, unknown> = declared.permissions,
  state: Record<string, unknown> = declared.state,
  input: unknown = greeted
) => {
  const result = checkWorkflow({
    $schema: "https://grasp.work/schemas/grasp-workflow/2.json",
    args: input,
    params: declared.params,
    permissions,
    state,
    ...(output === undefined
      ? {}
      : { returns: output.schema, result: output.value }),
    steps,
  });
  if (!result.ok) {
    throw new Error(`Not a valid workflow: ${JSON.stringify(result.problems)}`);
  }
  const generation = generateWorkflow(result.workflow);
  // The table as core seals it (tasks.json): its own schema reads it.
  const table = sealedTableSchema.parse(
    structuredClone({
      tasks: generation.tasks,
      expressions: generation.expressions,
      workflow: generation.workflow,
      params: generation.params,
    })
  );
  const build = await buildGeneratedWorkflow(
    env,
    { [generatedPath]: generation.source },
    "workflow-schema-runs"
  );
  const source = build.ok
    ? build.modules[appModuleName(generatedPath)]
    : undefined;
  if (source === undefined) {
    throw new Error(`Not built: ${JSON.stringify(build)}`);
  }
  return {
    source,
    sealed: (run: HostedSealedRun): HostedSealedRun => ({
      ...run,
      build: { ...run.build, ...table },
    }),
  };
};

describe("a grasp-workflow/2 workflow's generated code on the run host", () => {
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
    const { source, sealed: withTable } = await generated(
      [
        { id: "linger", type: "wait", for: "1 hour" },
        {
          id: "send",
          type: "call",
          connection: "mail",
          action: "mail.send",
          args: {
            to: { $expr: "args.who" },
            subject: { $expr: "params.token" },
          },
        },
        {
          id: "greet",
          type: "generate",
          instructions: "Greet them.",
          input: { who: { $expr: "args.who" } },
          returns: greeting,
        },
        {
          id: "known",
          type: "if",
          condition: { $expr: 'greet.line === "Hello Ada"' },
          // oxlint-disable-next-line unicorn/no-thenable -- the if step's list
          then: [{ id: "pause", type: "wait", until: { $expr: "0" } }],
          else: [
            {
              id: "stop",
              type: "raise",
              error: { code: "test.stop", message: "Failed." },
            },
          ],
        },
        {
          id: "guarded",
          type: "try",
          try: [
            {
              id: "fetch",
              type: "call",
              connection: "mail",
              action: "mail.send",
              args: { to: { $expr: "args.who" }, subject: "x" },
            },
          ],
          catch: {
            retry: { attempts: 3, delay: "1 second", backoff: "constant" },
          },
        },
      ],
      {
        schema: objectOf({
          line: { kind: "string" },
          sent: { kind: "string" },
        }),
        value: {
          line: { $expr: "greet.line" },
          sent: { $expr: "typeof send.messageId" },
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
        { step: "greet:task", call: "grasp.model", binding: "ai" },
        { step: "fetch:task", call: "grasp.connector", binding: "mail" },
      ],
    });
  });

  it("runs a loop's items in order, a catch taking an item's raise, and stops where its `while` doesn't hold", async () => {
    const { source, sealed: withTable } = await generated(
      [
        {
          id: "rows",
          type: "forEach",
          items: { $expr: "args.rows" },
          while: { $expr: 'item !== "stop"' },
          do: [
            {
              id: "notify",
              type: "call",
              connection: "mail",
              action: "mail.send",
              args: { to: { $expr: "item" }, subject: "row" },
            },
            {
              id: "guard",
              type: "try",
              try: [
                {
                  id: "check",
                  type: "raise",
                  if: { $expr: 'item === "b"' },
                  error: { code: "test.bad", message: "Failed." },
                },
              ],
              catch: { code: "test.bad" },
            },
          ],
        },
      ],
      undefined,
      declared.permissions,
      declared.state,
      rowsOf({ kind: "string" })
    );
    const runId = await waitingRun(sealed);
    const ran = await ranAs(runId, source, {
      engine: retryingEngine(),
      // Its rows as its input, in place of the started run's.
      sealed: (run) =>
        withTable({ ...run, input: { rows: ["a", "b", "stop", "c"] } }),
    });
    const { sent } = await sealed.mail.did();
    const checked = await checkedCalls(runId);
    expect({
      ran,
      sent: sent.filter(({ subject }) => subject === "row"),
      checked: checked.map(({ step }) => step),
    }).toStrictEqual({
      ran: { ended: null, tampered: [] },
      // Item 2 is "stop": its `while` doesn't hold, and no step of it, nor
      // of item 3, runs. Item 1's raise its catch takes in the code.
      sent: [
        { to: "a", subject: "row" },
        { to: "b", subject: "row" },
      ],
      checked: ["notify:task", "notify:task@1"],
    });
  });

  it("runs a nested loop of any ID, its items reading a field named like a built-in's method", async () => {
    const { source, sealed: withTable } = await generated(
      [
        {
          id: "pages",
          type: "forEach",
          items: { $expr: "args.rows" },
          do: [
            {
              // `own`: the generated code reads such a field by `$own`.
              id: "own",
              type: "forEach",
              items: { $expr: "item.rows" },
              do: [
                {
                  id: "notify",
                  type: "call",
                  connection: "mail",
                  action: "mail.send",
                  args: { to: { $expr: "item.at" }, subject: "nested" },
                },
              ],
            },
          ],
        },
      ],
      undefined,
      declared.permissions,
      declared.state,
      rowsOf(
        objectOf({
          rows: { kind: "array", item: objectOf({ at: { kind: "string" } }) },
        })
      )
    );
    const runId = await waitingRun(sealed);
    const ran = await ranAs(runId, source, {
      engine: retryingEngine(),
      sealed: (run) =>
        withTable({
          ...run,
          input: { rows: [{ rows: [{ at: "nestedA" }, { at: "nestedB" }] }] },
        }),
    });
    const { sent } = await sealed.mail.did();
    expect({
      ran,
      sent: sent.filter(({ subject }) => subject === "nested"),
    }).toStrictEqual({
      ran: { ended: null, tampered: [] },
      sent: [
        { to: "nestedA", subject: "nested" },
        { to: "nestedB", subject: "nested" },
      ],
    });
  });

  it("calls each action of a connection by its own member, two that read alike without their group each by its whole name", async () => {
    const { source, sealed: withTable } = await generated([
      calling("grouped", "mail.readX"),
      calling("bare", "read-x"),
    ]);
    const runId = await waitingRun(sealed);
    const ran = await ranAs(runId, source, {
      engine: retryingEngine(),
      sealed: withTable,
    });
    const checked = await checkedCalls(runId);
    expect({
      ran,
      checked: checked.map(({ step, operation }) => ({ step, operation })),
    }).toStrictEqual({
      ran: { ended: null, tampered: [] },
      checked: [
        { step: "grouped:task", operation: "mail.readX" },
        { step: "bare:task", operation: "read-x" },
      ],
    });
  });

  it("replays a loop stopped after its first item's call: the same items, that call not made again, nothing refused", async () => {
    const { source, sealed: withTable } = await generated(
      [
        {
          id: "rows",
          type: "forEach",
          items: { $expr: "args.rows" },
          do: [
            {
              id: "notify",
              type: "call",
              connection: "mail",
              action: "mail.send",
              args: { to: { $expr: "item" }, subject: "replayed row" },
            },
          ],
        },
      ],
      {
        schema: { kind: "array", item: { kind: "string" } },
        value: { $expr: "args.rows" },
      },
      declared.permissions,
      declared.state,
      rowsOf({ kind: "string" })
    );
    const runId = await waitingRun(sealed);
    const rows = (run: HostedSealedRun) =>
      withTable({ ...run, input: { rows: ["a", "b"] } });
    const journal = new Map<string, Journaled>();
    const second = "notify:task@1";
    const first = await ranAs(runId, source, {
      engine: evictedBefore(journalingEngine(journal, []), second),
      sealed: rows,
    });
    const ranAgain: string[] = [];
    const replayed = await ranAs(runId, source, {
      engine: journalingEngine(journal, ranAgain),
      sealed: rows,
    });
    const { sent } = await sealed.mail.did();
    expect({
      first: first.tampered,
      replayed,
      ranAgain,
      sent: sent.filter(({ subject }) => subject === "replayed row"),
    }).toStrictEqual({
      first: [],
      replayed: { ended: ["a", "b"], tampered: [] },
      // Its items and its first item's call are the journal's.
      ranAgain: [second, "workflow:output"],
      sent: [
        { to: "a", subject: "replayed row" },
        { to: "b", subject: "replayed row" },
      ],
    });
  });

  it("passes over an item whose steps were all skipped by their `if`, and runs the item after it", async () => {
    const { source, sealed: withTable } = await generated(
      [
        {
          id: "rows",
          type: "forEach",
          items: { $expr: "args.rows" },
          do: [
            {
              id: "notify",
              type: "call",
              if: { $expr: 'item !== "skip"' },
              connection: "mail",
              action: "mail.send",
              args: { to: { $expr: "item" }, subject: "passed over" },
            },
            {
              id: "late",
              type: "wait",
              if: { $expr: 'item !== "skip"' },
              for: "1 second",
            },
          ],
        },
      ],
      undefined,
      declared.permissions,
      declared.state,
      rowsOf({ kind: "string" })
    );
    const runId = await waitingRun(sealed);
    const ran = await ranAs(runId, source, {
      engine: retryingEngine(),
      sealed: (run) => withTable({ ...run, input: { rows: ["skip", "a"] } }),
    });
    const { sent } = await sealed.mail.did();
    const checked = await checkedCalls(runId);
    expect({
      ran,
      sent: sent.filter(({ subject }) => subject === "passed over"),
      checked: checked.map(({ step }) => step),
    }).toStrictEqual({
      // Item 0 ran no step; item 1 starts past it, nothing refused.
      ran: { ended: null, tampered: [] },
      sent: [{ to: "a", subject: "passed over" }],
      // The first run of `notify`, in item 1.
      checked: ["notify:task"],
    });
  });

  it("takes an `if` that throws in an item in the item's own catch, as its code's failure, refusing nothing", async () => {
    const { source, sealed: withTable } = await generated(
      [
        {
          id: "rows",
          type: "forEach",
          items: { $expr: "args.rows" },
          do: [
            {
              id: "guard",
              type: "try",
              try: [
                {
                  id: "notify",
                  type: "call",
                  // Item 0 is null: reading its `to` throws.
                  if: { $expr: 'item.to !== ""' },
                  connection: "mail",
                  action: "mail.send",
                  args: { to: { $expr: "item.to" }, subject: "throwing" },
                },
              ],
              catch: {
                do: [
                  {
                    id: "report",
                    type: "call",
                    connection: "mail",
                    action: "mail.send",
                    args: {
                      to: "ops",
                      subject: {
                        $expr: 'error.code + " | " + error.message',
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
      undefined,
      declared.permissions,
      declared.state,
      rowsOf({
        kind: "object",
        fields: { to: { kind: "string" } },
        nullable: true,
      })
    );
    const runId = await waitingRun(sealed);
    const ran = await ranAs(runId, source, {
      engine: retryingEngine(),
      sealed: (run) =>
        withTable({ ...run, input: { rows: [null, { to: "a" }] } }),
    });
    const { sent } = await sealed.mail.did();
    const checked = await checkedCalls(runId);
    expect({
      ran,
      sent: sent.filter(
        ({ to, subject }) => subject === "throwing" || to === "ops"
      ),
      checked: checked.map(({ step }) => step),
    }).toStrictEqual({
      ran: { ended: null, tampered: [] },
      // Item 0's `if` threw in its code, before any step: its catch takes
      // it as an expression's failure, in the platform's words; then item
      // 1's `notify` runs, its first.
      sent: [
        { to: "ops", subject: "expression.failed | The expression failed." },
        { to: "a", subject: "throwing" },
      ],
      checked: ["report:task", "notify:task"],
    });
  });

  it("records a list with a missing field as JSON, its item `null`, and runs its items", async () => {
    const { source, sealed: withTable } = await generated(
      [
        {
          id: "rows",
          type: "forEach",
          // `args.missing` isn't there: the list's item is `null`.
          items: { $expr: "[args.first, args.missing]" },
          do: [
            {
              id: "notify",
              type: "call",
              connection: "mail",
              action: "mail.send",
              args: {
                to: { $expr: 'item ?? "nobody"' },
                subject: "listed",
              },
            },
          ],
        },
      ],
      undefined,
      declared.permissions,
      declared.state,
      objectOf({
        first: { kind: "string" },
        missing: { kind: "string", optional: true },
      })
    );
    const runId = await waitingRun(sealed);
    const ran = await ranAs(runId, source, {
      engine: retryingEngine(),
      sealed: (run) => withTable({ ...run, input: { first: "a" } }),
    });
    const { sent } = await sealed.mail.did();
    expect({
      ran,
      sent: sent
        .filter(({ subject }) => subject === "listed")
        .map(({ to }) => to),
    }).toStrictEqual({
      ran: { ended: null, tampered: [] },
      sent: ["a", "nobody"],
    });
  });

  it("ends a loop that reaches the run's step ceiling, saying to split the work", async () => {
    const { source, sealed: withTable } = await generated(
      [
        {
          id: "rows",
          type: "forEach",
          items: { $expr: "args.rows" },
          do: [
            {
              id: "notify",
              type: "call",
              connection: "mail",
              action: "mail.send",
              args: { to: { $expr: "item" }, subject: "ceiling" },
            },
          ],
        },
      ],
      undefined,
      declared.permissions,
      declared.state,
      rowsOf({ kind: "string" })
    );
    const engine = retryingEngine();
    const ran = await ranAs(await waitingRun(sealed), source, {
      // A ceiling of 3 steps in place of the platform's: three items'
      // mail fit, the fourth item's doesn't.
      engine: { ...engine, step: countedStep(engine.step, 3) },
      sealed: (run) =>
        withTable({ ...run, input: { rows: ["a", "b", "c", "d"] } }),
    });
    const { sent } = await sealed.mail.did();
    expect({
      ran,
      sent: sent
        .filter(({ subject }) => subject === "ceiling")
        .map(({ to }) => to),
    }).toStrictEqual({
      ran: {
        ended: "workflow.too_many_steps",
        why: workflowErrors.create("workflow.too_many_steps").message,
        tampered: [],
      },
      sent: ["a", "b", "c"],
    });
  });

  it("raises its sealed error, which its catch takes, and skips a step whose `if` doesn't hold", async () => {
    const { source, sealed: withTable } = await generated(
      [
        {
          id: "skipped",
          type: "call",
          if: { $expr: 'args.who === "Bob"' },
          connection: "mail",
          action: "mail.send",
          args: { to: "bob", subject: "never" },
        },
        {
          id: "unraised",
          type: "raise",
          if: { $expr: 'args.who === "Bob"' },
          error: { code: "test.bob", message: "Failed." },
        },
        {
          id: "guarded",
          type: "try",
          try: [
            {
              id: "stop",
              type: "raise",
              error: { code: "test.stop", message: "Stopped." },
            },
          ],
          catch: {
            code: "test.stop",
            do: [
              {
                id: "notice",
                type: "call",
                connection: "mail",
                action: "mail.send",
                args: {
                  to: { $expr: "args.who" },
                  subject: { $expr: "error.code" },
                },
              },
            ],
          },
        },
      ],
      {
        schema: objectOf({ skipped: { kind: "boolean" } }),
        value: { skipped: { $expr: "skipped === null" } },
      }
    );
    const ran = await ranAs(await waitingRun(sealed), source, {
      engine: retryingEngine(),
      sealed: withTable,
    });
    const { sent } = await sealed.mail.did();
    expect({ ran, notice: sent.at(-1) }).toStrictEqual({
      ran: { ended: { skipped: true }, tampered: [] },
      notice: { to: "Ada", subject: "test.stop" },
    });
  });

  it("fails the run with a raise no catch takes", async () => {
    const { source, sealed: withTable } = await generated([
      {
        id: "stop",
        type: "raise",
        error: { code: "test.stop", message: "Failed." },
      },
    ]);
    const ran = await ranAs(await waitingRun(sealed), source, {
      engine: retryingEngine(),
      sealed: withTable,
    });
    expect(ran).toStrictEqual({
      ended: "test.stop",
      why: "Failed.",
      tampered: [],
    });
  });

  it("takes a deadline that fails to evaluate inside a retrying try as the expression's failure, not retried", async () => {
    const tries = new Map<string, number>();
    const { source, sealed: withTable } = await generated([
      {
        id: "guarded",
        type: "try",
        try: [
          // Reads past a key no run kept: it throws, in the code.
          { id: "pause", type: "wait", until: { $expr: "state.never.at" } },
        ],
        catch: {
          retry: {
            attempts: 2,
            delay: "1 second",
            backoff: "constant",
            when: { $expr: 'error.code !== ""' },
          },
        },
      },
    ]);
    const ran = await ranAs(await waitingRun(sealed), source, {
      engine: retryingEngine(tries),
      sealed: withTable,
    });
    const keys = [...tries.keys()];
    expect({
      ran,
      decided: keys.filter((key) => key.endsWith(":decide")).length,
      retried: keys.filter((key) => key.endsWith(":run")).length,
      paused: keys.some((key) => key.startsWith("key:pause:")),
    }).toStrictEqual({
      // Its deadline threw in its code, before its step: no step failed,
      // nothing is retried, and its catch takes it in the code.
      ran: { ended: null, tampered: [] },
      decided: 0,
      retried: 0,
      paused: false,
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

/** The permissions of `localWorkflow`'s workflow, as grasp-workflow/2 declares them. */
const local = {
  modules: {
    total: { kind: "compute", contract: "local:code/total.ts#total" },
    broken: { kind: "compute", contract: "local:code/total.ts#broken" },
    note: { kind: "action", contract: "local:code/note.ts#note" },
  },
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
      args: objectOf({ who: { kind: "string" } }),
      returns: objectOf({ status: { kind: "string" } }),
      result: { status: "done" },
      permissions: local,
      steps: [
        { id: "linger", type: "wait", for: "1 hour" },
        { id: "add", type: "call", module: "total", args: [1, 2, 3] },
        { id: "fail", type: "call", module: "broken", args: 1 },
        {
          id: "tell",
          type: "call",
          module: "note",
          args: { to: { $expr: "args.who" } },
        },
      ],
    }),
    basedOn: null,
    modules: { "code/total.ts": totalModule, "code/note.ts": noteModule },
  });
  return { by, workflow };
};

/** A step calling `broken`, which always fails. */
const fail = { id: "fail", type: "call", module: "broken", args: 1 };

/** Try `guarded` around `inside`: its catch takes, and retries, while these hold. */
const guarded = (
  inside: unknown[],
  when: { catch: string; retry?: string }
) => ({
  id: "guarded",
  type: "try",
  try: inside,
  catch: {
    when: { $expr: when.catch },
    retry: {
      attempts: 3,
      delay: "1 second",
      backoff: "constant",
      ...(when.retry === undefined ? {} : { when: { $expr: when.retry } }),
    },
    do: [
      {
        id: "tell",
        type: "call",
        module: "note",
        args: { to: { $expr: "error.code" } },
      },
    ],
  },
});

/**
 * `guarded` in each page of a loop, around a loop over the page's rows:
 * where the try is written, `item` is the page, which says to retry;
 * inside the rows, where its step fails, it is a row, which says not to.
 */
const inPages = (when: { catch: string; retry?: string }) => [
  {
    id: "pages",
    type: "forEach",
    items: { $expr: "[{ again: true, rows: [{ again: false }] }]" },
    do: [
      guarded(
        [
          {
            id: "rows",
            type: "forEach",
            items: { $expr: "item.rows" },
            do: [fail],
          },
        ],
        when
      ),
    ],
  },
];

describe("a grasp-workflow/2 workflow's own modules on the run host", () => {
  let owned: Awaited<ReturnType<typeof localWorkflow>>;

  beforeAll(async () => {
    owned = await localWorkflow();
  });

  afterAll(endLiveResourceRuns);

  it("calls a compute and an action binding as sealed, refusing none", async () => {
    const { source, sealed: withTable } = await generated(
      [
        { id: "linger", type: "wait", for: "1 hour" },
        {
          id: "add",
          type: "call",
          module: "total",
          args: [1, { $expr: "args.who.length" }, 3],
        },
        {
          id: "tell",
          type: "call",
          module: "note",
          args: { to: { $expr: "args.who" } },
        },
      ],
      {
        schema: objectOf({
          total: { kind: "number" },
          told: { kind: "string" },
        }),
        value: {
          total: { $expr: "add" },
          told: { $expr: "tell.status" },
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

  it("decides a catch's and a retry's `when` as booleans where the try is written, retrying while the retry's holds", async () => {
    const ranWith = async (steps: unknown[]) => {
      const tries = new Map<string, number>();
      const { source, sealed: withTable } = await generated(
        steps,
        undefined,
        local
      );
      const ran = await ranAs(await waitingRun(owned), source, {
        engine: retryingEngine(tries),
        sealed: withTable,
      });
      return { ran, guarded: guardedRan(tries) };
    };
    // Rounds 2 and 3 of its 3 attempts, each decided, then caught.
    const retriedThenCaught = {
      ran: { ended: null, tampered: [] },
      guarded: {
        decided: 2,
        retried: 2,
        failed: 1,
        told: true,
      },
    };
    expect({
      // A number: the choice the host reads takes a boolean.
      booleans: await ranWith([
        guarded([fail], {
          catch: 'error.code !== ""',
          retry: "error.code.length",
        }),
      ]),
      retryReadsThePage: await ranWith(
        inPages({ catch: 'error.code !== ""', retry: "item.again" })
      ),
      catchReadsThePage: await ranWith(inPages({ catch: "item.again" })),
      // Its retry would hold, but its catch wouldn't take the failure: no
      // round is tried first, and the run fails with it.
      catchDeclines: await ranWith(inPages({ catch: "!item.again" })),
    }).toStrictEqual({
      booleans: retriedThenCaught,
      retryReadsThePage: retriedThenCaught,
      catchReadsThePage: retriedThenCaught,
      catchDeclines: {
        ran: failedWith("workflow.compute_failed"),
        guarded: { decided: 1, retried: 0, failed: 1, told: false },
      },
    });
  });

  it("takes a retry `when` that throws as not retrying, the failure recorded and caught", async () => {
    const tries = new Map<string, number>();
    const { source, sealed: withTable } = await generated(
      [
        {
          id: "guarded",
          type: "try",
          try: [{ id: "fail", type: "call", module: "broken", args: 1 }],
          catch: {
            retry: {
              attempts: 3,
              delay: "1 second",
              backoff: "constant",
              // Reads past details the host never gives: it throws.
              when: { $expr: "error.details.deeper === 1" },
            },
            do: [
              {
                id: "tell",
                type: "call",
                module: "note",
                args: { to: { $expr: "error.code" } },
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
        told: true,
      },
    });
  });
});

/** `decisionWorkflow`'s decision binding, as a document declares it. */
const approval = { decisions: { approval: { contract: "grasp.approvals@1" } } };

/** `decisionWorkflow`'s input: who reviews, and which invoice. */
const reviewing = objectOf({
  reviewer: { kind: "string" },
  invoice: { kind: "string" },
});

/** A decision of binding `approval` on input `{ reviewer, invoice }`. */
const review = (change: Record<string, unknown> = {}) => ({
  id: "review",
  type: "decide",
  decision: "approval",
  recipients: [{ $expr: "args.reviewer" }, "role:builder"],
  prompt: "Approve the invoice",
  input: { invoice: { $expr: "args.invoice" } },
  timeout: "7 days",
  ...change,
});

/** What a run ends with: how decision `review` ended, as later steps read it. */
const decided = {
  schema: objectOf({
    timedOut: { kind: "boolean" },
    approved: { kind: "boolean" },
    by: { kind: "string" },
    comment: { kind: "string" },
  }),
  value: {
    timedOut: { $expr: "review.timedOut" },
    approved: { $expr: "!review.timedOut && review.approved" },
    by: { $expr: 'review.timedOut ? "" : review.by' },
    comment: { $expr: 'review.timedOut ? "" : review.payload?.comment ?? ""' },
  },
};

// A decision's generated code on the run host (#1923): the deciders its
// enter step records, `from` exactly the first of them, the run's own
// person never answering, a timeout answering `{ timedOut: true }`, and
// a decision in each item of a loop under that item's keys.
describe("a grasp-workflow/2 decision's generated code on the run host", () => {
  let reviewed: Reviewed;

  beforeAll(async () => {
    reviewed = await decisionWorkflow();
  });

  afterAll(endLiveResourceRuns);

  it("asks whom its enter step recorded, never takes the answer of the run's own person, and answers a decider's", async () => {
    const { by, reviewer } = reviewed;
    const { source, sealed: withTable } = await generated(
      [review()],
      decided,
      approval,
      declared.state,
      reviewing
    );
    const runId = await reviewRun(reviewed, `person:${reviewer.userId}`);
    let starter: unknown;
    const ran = await ranAs(runId, source, {
      sealed: withTable,
      engine: decidingEngine(runId, async (decision) => {
        // The run's person holds the role it asks: still never.
        starter = await codeOf(async () => {
          await answerAs(by, decision, { approved: true });
        });
        await answerAs(reviewer, decision, {
          approved: true,
          payload: { comment: "Fine" },
        });
      }),
    });
    const decisions = await decisionsOf(runId);
    expect({
      ran,
      starter,
      decisions: decisions.map(({ step, description, status }) => ({
        step,
        description,
        status,
      })),
    }).toStrictEqual({
      ran: {
        ended: {
          timedOut: false,
          approved: true,
          by: reviewer.userId,
          comment: "Fine",
        },
        tampered: [],
      },
      starter: "decision.forbidden",
      // The recorded prompt, whatever the code described it as.
      decisions: [
        {
          step: "review:task",
          description: "Approve the invoice",
          status: "approved",
        },
      ],
    });
  });

  it("answers `{ timedOut: true }` once its timeout passes, and fails a bare user ID where its enter step records it", async () => {
    const { reviewer } = reviewed;
    const { source, sealed: withTable } = await generated(
      [review()],
      decided,
      approval,
      declared.state,
      reviewing
    );
    const lapsed = await reviewRun(reviewed, `person:${reviewer.userId}`);
    const timedOut = await ranAs(lapsed, source, {
      sealed: withTable,
      engine: decidingEngine(lapsed, deadlinePasses),
    });
    const bare = await reviewRun(reviewed, reviewer.userId);
    const bareId = await ranAs(bare, source, {
      sealed: withTable,
      engine: retryingEngine(),
    });
    expect({
      timedOut,
      bareId: { tampered: bareId.tampered, failed: "why" in bareId },
      opened: await decisionsOf(bare),
    }).toStrictEqual({
      timedOut: {
        ended: { timedOut: true, approved: false, by: "", comment: "" },
        tampered: [],
      },
      // Its code's own failure, not the host's refusal: nothing opened.
      bareId: { tampered: [], failed: true },
      opened: [],
    });
  });

  it("asks a prompt as long as its checker takes one, and with no timeout waits until the run's own deadline", async () => {
    const { reviewer } = reviewed;
    // 300 characters, each two UTF-16 units: within the 500 a prompt
    // takes, as the checker counts them and the host does.
    const prompt = "😀".repeat(300);
    const { source, sealed: withTable } = await generated(
      [
        {
          id: "review",
          type: "decide",
          decision: "approval",
          recipients: [{ $expr: "args.reviewer" }],
          prompt,
          input: { invoice: { $expr: "args.invoice" } },
        },
      ],
      decided,
      approval,
      declared.state,
      reviewing
    );
    const runId = await reviewRun(reviewed, `person:${reviewer.userId}`);
    const day = 86_400_000;
    // A run started a day before its age runs out: a day left to wait.
    const late = (run: HostedSealedRun) =>
      withTable({
        ...run,
        createdAt: Date.now() - platformLimits.workflowAgeMs + day,
      });
    const ran = await ranAs(runId, source, {
      sealed: late,
      engine: decidingEngine(runId, deadlinePasses),
    });
    const [opened] = await decisionsOf(runId);
    const expiry = await env.DB.prepare(
      "SELECT expires_at AS expiresAt FROM workflow_decisions WHERE resource_run_id = ?"
    )
      .bind(runId)
      .first<{ expiresAt: number }>();
    expect({
      ran,
      asked: opened?.description,
      withinADay: (expiry?.expiresAt ?? Infinity) <= Date.now() + day,
    }).toStrictEqual({
      ran: {
        ended: { timedOut: true, approved: false, by: "", comment: "" },
        tampered: [],
      },
      asked: prompt,
      withinADay: true,
    });
  });

  it("replays a decision as it ran: asked once, its answer the journal's", async () => {
    const { reviewer } = reviewed;
    const { source, sealed: withTable } = await generated(
      [review()],
      decided,
      approval,
      declared.state,
      reviewing
    );
    const runId = await reviewRun(reviewed, `person:${reviewer.userId}`);
    const journal = new Map<string, Journaled>();
    const first = await ranAs(runId, source, {
      sealed: withTable,
      engine: decidingEngine(
        runId,
        async (decision) => {
          await answerAs(reviewer, decision, { approved: true });
        },
        journalingEngine(journal, [])
      ),
    });
    const ranAgain: string[] = [];
    const replayed = await ranAs(runId, source, {
      sealed: withTable,
      // Nobody answers again: what it answered is the journal's.
      engine: decidingEngine(
        runId,
        deadlinePasses,
        journalingEngine(journal, ranAgain)
      ),
    });
    const answered = {
      timedOut: false,
      approved: true,
      by: reviewer.userId,
      comment: "",
    };
    const decisions = await decisionsOf(runId);
    expect({
      first,
      replayed,
      ranAgain,
      decisions: decisions.map(({ step, status }) => ({ step, status })),
    }).toStrictEqual({
      first: { ended: answered, tampered: [] },
      replayed: { ended: answered, tampered: [] },
      ranAgain: [],
      decisions: [{ step: "review:task", status: "approved" }],
    });
  });

  it("asks a decision in each item of a loop, under that item's keys", async () => {
    const { reviewer } = reviewed;
    const { source, sealed: withTable } = await generated(
      [
        {
          id: "batch",
          type: "forEach",
          items: { $expr: '["INV-1", "INV-2"]' },
          do: [
            review({
              id: "sign",
              prompt: "Approve this one",
              input: { invoice: { $expr: "item" } },
            }),
          ],
        },
      ],
      undefined,
      approval,
      declared.state,
      reviewing
    );
    const runId = await reviewRun(reviewed, `person:${reviewer.userId}`);
    const ran = await ranAs(runId, source, {
      sealed: withTable,
      engine: decidingEngine(runId, async () => {
        // Each item's own decision, the latest opened.
        const opened = await decisionsOf(runId);
        await answerAs(reviewer, opened.at(-1)?.id ?? "", { approved: true });
      }),
    });
    const decisions = await decisionsOf(runId);
    expect({
      ran,
      decisions: decisions.map(({ step, input, status }) => ({
        step,
        input,
        status,
      })),
    }).toStrictEqual({
      ran: { ended: null, tampered: [] },
      decisions: [
        {
          step: "sign:task",
          input: JSON.stringify({ invoice: "INV-1" }),
          status: "approved",
        },
        {
          step: "sign:task@1",
          input: JSON.stringify({ invoice: "INV-2" }),
          status: "approved",
        },
      ],
    });
  });
});

/** The types of `eventWorkflow`'s event contract: a reply, and a bounce. */
const received = "grasp.reply.received";
const bounced = "grasp.reply.bounced";

/** Where `eventWorkflow`'s events come from: an App, as its page sends. */
const fromApp = "https://grasp.test/apps/replies";

/**
 * A workflow of `by`'s on input `{ who }`, published and its event
 * binding `replies` approved by `admin`: after an hour's wait, it listens
 * through `replies` for a reply or a bounce, each of data `{ from }`.
 */
const eventWorkflow = async () => {
  const admin = await person("admin");
  const by = await person("builder");
  const contract = `replies-${unique()}`;
  const data = descriptorOf(v.object({ from: v.string() }));
  await publishCatalogContract(env, admin, {
    key: contract,
    kind: "event",
    events: {
      [received]: { data, browser: false },
      [bounced]: { data, browser: false },
    },
  });
  const workflow = await createWorkflowResource(env, by, `replies-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: JSON.stringify({
      $schema: workflowSchemaUrl,
      args: objectOf({ who: { kind: "string" } }),
      permissions: { events: { replies: { contract } } },
      steps: [
        { id: "linger", type: "wait", for: "1 hour" },
        {
          id: "reply",
          type: "waitForEvent",
          events: "replies",
          eventType: [received, bounced],
          timeout: "3 days",
        },
      ],
    }),
    basedOn: null,
  });
  const approved = await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "replies",
    target: { kind: "event" },
    reviewed: { version: 1 },
  });
  return { admin, by, workflow, approval: approved };
};

type Listening = Awaited<ReturnType<typeof eventWorkflow>>;

/** `eventWorkflow`'s event binding, as a document declares it. */
const replies = { events: { replies: { contract: "grasp.replies@1" } } };

/** An event wait for a reply or a bounce through `replies`. */
const replyWait = (change: Record<string, unknown> = {}) => ({
  id: "reply",
  type: "waitForEvent",
  events: "replies",
  eventType: [received, bounced],
  timeout: "3 days",
  ...change,
});

/** What a run ends with: how wait `reply` ended, as later steps read it. */
const replied = {
  schema: objectOf({
    timedOut: { kind: "boolean" },
    type: { kind: "string" },
    from: { kind: "string" },
    source: { kind: "string" },
  }),
  value: {
    timedOut: { $expr: "reply.timedOut" },
    type: { $expr: 'reply.timedOut ? "" : reply.event.type' },
    from: { $expr: 'reply.timedOut ? "" : reply.event.data.from ?? ""' },
    source: { $expr: 'reply.timedOut ? "" : reply.event.source' },
  },
};

/** An App's event of `type` from `from`, sent to run `runId`. */
const sendTo = async (
  { workflow }: Listening,
  runId: string,
  type: string,
  from: string
) =>
  await admitRunEvent(env, {
    workflowId: workflow.id,
    runId,
    binding: "replies",
    type,
    data: { from },
    key: unique(),
    source: fromApp,
    sender: fromApp,
  });

/** What an engine's event waits were asked: each by its step, with its end. */
type Asked = { step: string; types: string[]; until: number }[];

/**
 * An engine whose waits for an event each take the event `sends` sends
 * the run as it begins, from the run's inbox as the engine keeps it, when
 * one of the wait's matches names its engine type, as the engine matches
 * them; and whose waits end as their deadline passes otherwise. What each
 * wait asked goes in `asked`.
 */
const listeningEngine = (
  runId: string,
  sends: () => Promise<{ id: string } | undefined>,
  asked: Asked
): Engine => {
  const { step, leaseOf } = newerEngine();
  return {
    leaseOf,
    step: {
      ...step,
      waitForMatch: async (name, { match, until }) => {
        asked.push({ step: name, types: match.map(({ type }) => type), until });
        const sent = await sends();
        const kept =
          sent === undefined
            ? null
            : await runEngine(env).eventOf(runId, sent.id);
        if (kept === null || !match.some(({ type }) => type === kept.type)) {
          return await deadlinePasses();
        }
        return { payload: decode(kept.payload), timestamp: new Date() };
      },
    },
  };
};

/** What an engine's waits for an event took, by their step. */
type Taken = Map<string, Awaited<ReturnType<Engine["step"]["waitForMatch"]>>>;

/**
 * `listening`'s waits, its other steps journaled as `journalingEngine`
 * journals them (those that ran in `ran`): each wait's event kept in
 * `taken`, which a replay takes it from, asking the engine nothing.
 */
const journaledListening = (
  listening: Engine,
  journal: Map<string, Journaled>,
  taken: Taken,
  ran: string[] = []
): Engine => {
  const journaled = journalingEngine(journal, ran);
  return {
    leaseOf: journaled.leaseOf,
    step: {
      ...journaled.step,
      waitForMatch: async (name, options) => {
        const kept = taken.get(name);
        if (kept !== undefined) {
          return kept;
        }
        const event = await listening.step.waitForMatch(name, options);
        taken.set(name, event);
        return event;
      },
    },
  };
};

/** The engine types the host keeps `replies`' events of `types` under. */
const keysOf = async (...types: string[]): Promise<string[]> =>
  await Promise.all(
    types.map(async (type) => await eventTypeKey("replies", type))
  );

/** The steps task `id` has in `run`'s build, its table `seal`ed in. */
const sealedSteps = (
  run: HostedSealedRun,
  seal: (loaded: HostedSealedRun) => HostedSealedRun,
  id: string
) => seal(run).build.tasks.find((task) => task.id === id)?.steps;

/** Sends nothing: the wait's deadline passes. */
const nothingSent = async (): Promise<undefined> => {
  await Promise.resolve();
};

// An event wait's generated code on the run host: the first event of its
// sealed binding and types an App sends the run, as the host minted it; a
// timeout an outcome, `{ timedOut: true }`, never a failure; a wait in
// each item of a loop under that item's keys; and a binding revoked since
// the start, `workflow.event_denied`, failing the run, which no catch takes.
/** A refused publication's problems, each as its code and pointer. */
const pointers = (error: unknown) =>
  z
    .object({
      details: z.object({
        problems: z.array(z.object({ code: z.string(), pointer: z.string() })),
      }),
    })
    .parse(error)
    .details.problems.map(({ code, pointer }) => `${code} ${pointer}`);

describe("a grasp-workflow/2 event wait's generated code on the run host", () => {
  let listening: Listening;

  beforeAll(async () => {
    listening = await eventWorkflow();
  });

  afterAll(endLiveResourceRuns);

  it("is published only for types its binding's contract admits, and records what it waits for as the version's listens", async () => {
    const admin = await person("admin");
    const by = await person("builder");
    const contract = `replies-${unique()}`;
    const data = descriptorOf(v.object({ from: v.string() }));
    await publishCatalogContract(env, admin, {
      key: contract,
      kind: "event",
      events: { [received]: { data, browser: false } },
    });
    const workflow = await createWorkflowResource(env, by, `waits-${unique()}`);
    const publishing = async (types: string | string[]) =>
      await publishWorkflowVersion(env, by, workflow.id, {
        definition: JSON.stringify({
          $schema: workflowSchemaUrl,
          permissions: { events: { replies: { contract } } },
          steps: [
            {
              id: "reply",
              type: "waitForEvent",
              events: "replies",
              eventType: types,
              timeout: "3 days",
            },
          ],
        }),
        basedOn: null,
      });
    const refused = await refusal(publishing([received, bounced]));
    const single = await refusal(publishing(bounced));
    await publishing(received);
    const stored = await env.DB.prepare(
      "SELECT contract FROM workflow_resource_versions WHERE workflow_resource_id = ?"
    )
      .bind(workflow.id)
      .first<{ contract: string }>();
    expect({
      refused: pointers(refused),
      single: pointers(single),
      listens: z
        .object({ listens: z.unknown() })
        .parse(JSON.parse(stored?.contract ?? "{}")).listens,
    }).toStrictEqual({
      // A wait for a type it can never be sent would end only by timing out.
      refused: ["event.unknown_type /steps/0/eventType/1"],
      single: ["event.unknown_type /steps/0/eventType"],
      listens: { reply: { alias: "replies", types: [received] } },
    });
  });

  it("takes an event of its binding and types an App sends the run, as the host minted it", async () => {
    const { source, sealed: withTable } = await generated(
      [replyWait()],
      replied,
      replies
    );
    const runId = await waitingRun(listening);
    const asked: Asked = [];
    const ran = await ranAs(runId, source, {
      sealed: withTable,
      engine: listeningEngine(
        runId,
        async () => await sendTo(listening, runId, bounced, "ada@acme.test"),
        asked
      ),
    });
    expect({
      ran,
      asked: asked.map(({ step, types }) => ({ step, types })),
    }).toStrictEqual({
      ran: {
        ended: {
          timedOut: false,
          type: bounced,
          from: "ada@acme.test",
          // The host's, from the sender's authority: never its input.
          source: fromApp,
        },
        tampered: [],
      },
      asked: [
        {
          step: "reply:task",
          types: await keysOf(received, bounced),
        },
      ],
    });
  });

  it("answers `{ timedOut: true }` once its sealed timeout passes, which a later step reads", async () => {
    const { source, sealed: withTable } = await generated(
      [
        replyWait({ timeout: "2 days" }),
        {
          id: "chase",
          type: "wait",
          if: { $expr: "reply.timedOut" },
          for: "1 hour",
        },
      ],
      replied,
      replies
    );
    const runId = await waitingRun(listening);
    const asked: Asked = [];
    const before = Date.now();
    const ran = await ranAs(runId, source, {
      sealed: withTable,
      engine: listeningEngine(runId, nothingSent, asked),
    });
    const after = Date.now();
    const until = asked.map((wait) => wait.until);
    expect({
      ran,
      // Its deadline is its sealed timeout from when it was first reached.
      sealedTimeout: until.map(
        (end) => end >= before + 2 * 86_400_000 && end <= after + 2 * 86_400_000
      ),
    }).toStrictEqual({
      ran: {
        ended: { timedOut: true, type: "", from: "", source: "" },
        tampered: [],
      },
      sealedTimeout: [true],
    });
  });

  it("waits in each item of a loop under that item's keys, each taking its own event", async () => {
    const { source, sealed: withTable } = await generated(
      [
        {
          id: "rounds",
          type: "forEach",
          items: { $expr: '["one", "two"]' },
          do: [
            replyWait({
              id: "each",
              events: "replies",
              eventType: received,
            }),
          ],
        },
      ],
      undefined,
      replies
    );
    const runId = await waitingRun(listening);
    const asked: Asked = [];
    const sent: string[] = [];
    const ran = await ranAs(runId, source, {
      sealed: withTable,
      engine: listeningEngine(
        runId,
        async () => {
          const event = await sendTo(
            listening,
            runId,
            received,
            `round-${sent.length}@acme.test`
          );
          sent.push(event.id);
          return event;
        },
        asked
      ),
    });
    expect({
      ran,
      asked: asked.map(({ step, types }) => ({ step, types })),
      sent: new Set(sent).size,
    }).toStrictEqual({
      ran: { ended: null, tampered: [] },
      asked: [
        { step: "each:task", types: await keysOf(received) },
        { step: "each:task@1", types: await keysOf(received) },
      ],
      sent: 2,
    });
  });

  it("skips a wait whose own `if` doesn't hold, at the top level and in an item, and the next item's wait takes its event", async () => {
    const skipped = await generated(
      [replyWait({ if: { $expr: 'args.who !== "Ada"' } })],
      {
        schema: objectOf({ skipped: { kind: "boolean" } }),
        value: { skipped: { $expr: "reply === null" } },
      },
      replies
    );
    const inItems = await generated(
      [
        {
          id: "rounds",
          type: "forEach",
          items: { $expr: '["skip", "take"]' },
          do: [
            replyWait({
              id: "each",
              if: { $expr: 'item === "take"' },
              events: "replies",
              eventType: received,
            }),
          ],
        },
      ],
      undefined,
      replies
    );
    const topRun = await waitingRun(listening);
    const itemRun = await waitingRun(listening);
    const asked: Asked = [];
    const sent: string[] = [];
    const top = await ranAs(topRun, skipped.source, {
      sealed: skipped.sealed,
      engine: listeningEngine(topRun, nothingSent, asked),
    });
    const items = await ranAs(itemRun, inItems.source, {
      sealed: inItems.sealed,
      engine: listeningEngine(
        itemRun,
        async () => {
          const event = await sendTo(listening, itemRun, received, "ada");
          sent.push(event.id);
          return event;
        },
        asked
      ),
    });
    const loaded = await sealedRunOf(topRun);
    expect({
      top,
      items,
      steps: {
        reply: sealedSteps(loaded, skipped.sealed, "reply"),
        each: sealedSteps(loaded, inItems.sealed, "each"),
      },
      // Only the second item's wait reached the engine, and took its event.
      asked: asked.map(({ step }) => step),
      sent: sent.length,
    }).toStrictEqual({
      top: { ended: { skipped: true }, tampered: [] },
      items: { ended: null, tampered: [] },
      // An `if` is the code's: no step records it.
      steps: { reply: ["task"], each: ["task"] },
      // The first run of `each`, in item 1.
      asked: ["each:task"],
      sent: 1,
    });
  });

  it("fails the run with `workflow.event_denied` once its binding is revoked, a `try` around it or not", async () => {
    const revoked = await eventWorkflow();
    const caught = await generated(
      [{ id: "guarded", type: "try", try: [replyWait()], catch: {} }],
      undefined,
      replies
    );
    const bare = await generated([replyWait()], undefined, replies);
    const caughtRun = await waitingRun(revoked);
    const bareRun = await waitingRun(revoked);
    await revokeWorkflowBinding(
      env,
      revoked.admin,
      revoked.workflow.id,
      revoked.approval.id
    );
    const asked: Asked = [];
    expect({
      caught: await ranAs(caughtRun, caught.source, {
        sealed: caught.sealed,
        engine: listeningEngine(caughtRun, nothingSent, asked),
      }),
      bare: await ranAs(bareRun, bare.source, {
        sealed: bare.sealed,
        engine: listeningEngine(bareRun, nothingSent, asked),
      }),
      // Refused before it waits: the engine is asked for nothing.
      asked,
    }).toStrictEqual({
      // No catch takes it: its catch of everything throws it on, so the
      // run ends with it, never as code that went on past it.
      caught: failedWith("workflow.event_denied"),
      bare: failedWith("workflow.event_denied"),
      asked: [],
    });
  });

  it("replays a wait that took its event as it ran, and fails the replay with `workflow.event_denied` once its binding is revoked, its `try` notwithstanding", async () => {
    const revoked = await eventWorkflow();
    const { source, sealed: withTable } = await generated(
      [{ id: "guarded", type: "try", try: [replyWait()], catch: {} }],
      undefined,
      replies
    );
    const runId = await waitingRun(revoked);
    const journal = new Map<string, Journaled>();
    const taken: Taken = new Map();
    const asked: Asked = [];
    const first = await ranAs(runId, source, {
      sealed: withTable,
      engine: journaledListening(
        listeningEngine(
          runId,
          async () => await sendTo(revoked, runId, received, "ada@acme.test"),
          asked
        ),
        journal,
        taken
      ),
    });
    // Each replay finds the wait's event in the journal: nothing is sent.
    const replay = async (ran: string[]) =>
      await ranAs(runId, source, {
        sealed: withTable,
        engine: journaledListening(
          listeningEngine(runId, nothingSent, asked),
          journal,
          taken,
          ran
        ),
      });
    const ranAgain: string[] = [];
    const replayed = await replay(ranAgain);
    await revokeWorkflowBinding(
      env,
      revoked.admin,
      revoked.workflow.id,
      revoked.approval.id
    );
    const ranRevoked: string[] = [];
    const afterRevoking = await replay(ranRevoked);
    expect({
      first,
      replayed,
      ranAgain,
      afterRevoking,
      ranRevoked,
      // The engine was asked once, by the first run.
      asked: asked.map(({ step }) => step),
    }).toStrictEqual({
      first: { ended: null, tampered: [] },
      replayed: { ended: null, tampered: [] },
      ranAgain: [],
      // The path the run took is gone: its code's catch can't take the
      // failure, so the run ends with it, never on a path it never took.
      afterRevoking: failedWith("workflow.event_denied"),
      ranRevoked: [],
      asked: ["reply:task"],
    });
  });
});

/**
 * The release's contract for replies to a run's mail, and its type: the
 * one whose type comes from outside, by email.
 */
const emailReplies = () => {
  for (const contract of releaseContracts) {
    for (const [type, event] of Object.entries(contract.events ?? {})) {
      if ("ingress" in event && event.ingress === "email") {
        return { contract, type };
      }
    }
  }
  throw new Error("The release has no contract for replies to a run's mail");
};

/**
 * The workflow's own mail: an action that answers whom it mailed and where
 * their replies go, reaching nothing, as a mail connector's call would
 * carry its Reply-To.
 */
const askModule = `import { action, v } from "@grasp-os/sdk/action";

export const ask = action({
  args: { to: v.string(), replyTo: v.string() },
  returns: v.object({ to: v.string(), replyTo: v.string() }),
  uses: [],
  handler: async (_ctx, { to, replyTo }) => ({ to, replyTo }),
});
`;

/**
 * A workflow of `by`'s on input `{ who }`, published with its own mail
 * action `ask`, and its event binding `replies`, of the release's
 * contract for replies to the run's mail, approved by `admin`: so each of
 * its runs has a reply address for `replies`.
 */
const replyingWorkflow = async () => {
  const admin = await person("admin");
  const by = await person("builder");
  const reply = emailReplies();
  await ensureReleaseContract(env, reply.contract, { builtin: "release" });
  const workflow = await createWorkflowResource(env, by, `asks-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: JSON.stringify({
      $schema: workflowSchemaUrl,
      args: objectOf({ who: { kind: "string" } }),
      permissions: {
        modules: { ask: { kind: "action", contract: "local:code/ask.ts#ask" } },
        events: { replies: { contract: reply.contract.key } },
      },
      steps: [
        { id: "linger", type: "wait", for: "1 hour" },
        {
          id: "ask",
          type: "call",
          module: "ask",
          args: { to: { $expr: "args.who" }, replyTo: "x" },
        },
        {
          id: "reply",
          type: "waitForEvent",
          events: "replies",
          eventType: reply.type,
          timeout: "7 days",
        },
      ],
    }),
    basedOn: null,
    modules: { "code/ask.ts": askModule },
  });
  await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "replies",
    target: { kind: "event" },
    reviewed: { version: 1 },
  });
  return { by, workflow, replyType: reply.type };
};

/** A run's reply address, as `WorkflowContext.inbox` has it. */
const replyAddress = /^reply-[0-9a-f]{32}@/u;

/** A reply from `address`, as the run's inbox takes one by email. */
const replyFrom = (address: string) => ({
  id: `<${unique()}@acme.test>`,
  stored: null,
  from: { name: "Ada", address },
  to: [],
  cc: [],
  subject: "Re: Can you approve?",
  date: null,
  text: "Approved.",
  truncated: false,
  attachments: [],
  authentication: {
    spf: { result: "pass", domain: "acme.test" },
    dkim: { result: "pass", domain: "acme.test" },
    dmarc: { result: "pass", domain: "acme.test" },
  },
});

// `inbox.<alias>` on the run host: the run's reply address for event
// binding `replies`, which its mail gives as its Reply-To, sealed as any
// argument the isolate fills in, and the wait on `replies` after it,
// which takes the reply.
describe("a grasp-workflow/2 run's inbox on the run host", () => {
  afterAll(endLiveResourceRuns);

  it("mails its reply address as the Reply-To, and its wait on that binding takes the reply", async () => {
    const replying = await replyingWorkflow();
    const { source, sealed: withTable } = await generated(
      [
        {
          id: "ask",
          type: "call",
          module: "ask",
          if: { $expr: 'typeof inbox.replies === "string"' },
          args: {
            to: { $expr: "args.who" },
            replyTo: { $expr: "inbox.replies" },
          },
        },
        {
          id: "reply",
          type: "waitForEvent",
          events: "replies",
          eventType: replying.replyType,
          timeout: "7 days",
        },
      ],
      {
        schema: objectOf({
          mailed: { kind: "string" },
          replyTo: { kind: "string" },
          from: { kind: "string" },
          dmarc: { kind: "string" },
        }),
        value: {
          mailed: { $expr: 'ask?.replyTo ?? ""' },
          replyTo: { $expr: 'inbox.replies ?? ""' },
          from: {
            $expr: 'reply.timedOut ? "" : reply.event.data.from.address ?? ""',
          },
          dmarc: {
            $expr:
              'reply.timedOut ? "" : reply.event.data.authentication.dmarc?.result ?? ""',
          },
        },
      },
      {
        modules: { ask: { kind: "action", contract: "local:code/ask.ts#ask" } },
        events: { replies: { contract: "grasp/email-reply" } },
      }
    );
    const runId = await waitingRun(replying);
    const asked: Asked = [];
    const ran = await ranAs(runId, source, {
      sealed: withTable,
      engine: listeningEngine(
        runId,
        async () =>
          await admitRunEvent(env, {
            workflowId: replying.workflow.id,
            runId,
            binding: "replies",
            type: replying.replyType,
            data: replyFrom("ada@acme.test"),
            key: unique(),
            source: "mailto:ada@acme.test",
            sender: "mailto:ada@acme.test",
          }),
        asked
      ),
    });
    const address = z.object({ replyTo: z.string() }).safeParse(ran.ended)
      .data?.replyTo;
    expect({
      // The run's own address, as `inbox.replies` read it.
      address: replyAddress.test(address ?? ""),
      ran,
      asked: asked.map(({ step, types }) => ({ step, types })),
    }).toStrictEqual({
      address: true,
      ran: {
        ended: {
          // The mail went out with that address as its Reply-To.
          mailed: address,
          replyTo: address,
          from: "ada@acme.test",
          dmarc: "pass",
        },
        tampered: [],
      },
      asked: [
        {
          step: "reply:task",
          types: [await eventTypeKey("replies", replying.replyType)],
        },
      ],
    });
  });
});

/** How many times run `runId`'s steps wrote the workflow's state. */
const stateWrites = async (runId: string): Promise<number> => {
  const events = await allEvents();
  return events.filter(
    ({ action, target }) =>
      action === "workflow.state.written" && target?.id === runId
  ).length;
};

/** A mail to the run's person, its subject what the state kept, or "none". */
const remember = {
  id: "remember",
  type: "call",
  connection: "mail",
  action: "mail.send",
  args: {
    to: { $expr: "args.who" },
    subject: { $expr: 'state.last ?? "none"' },
  },
  state: {
    last: { $expr: "output.messageId" },
    previous: { $expr: 'state.last ?? "none"' },
    runs: { $expr: "(state.runs ?? 0) + 1" },
    kind: "visit",
  },
};

/** What a run read of `remember`'s state: as its output's schema and value. */
const readState = {
  schema: objectOf({
    last: { kind: "string" },
    previous: { kind: "string" },
    runs: { kind: "number" },
    kind: { kind: "string" },
  }),
  value: {
    last: { $expr: 'state.last ?? "none"' },
    previous: { $expr: 'state.previous ?? "none"' },
    runs: { $expr: "state.runs ?? 0" },
    kind: { $expr: 'state.kind ?? "none"' },
  },
};

// What a step keeps in its workflow's state, end to end: written by the
// host from the record of the step that kept it, once that step
// succeeded, and read by the workflow's next run as `state.<key>`, the
// snapshot its start froze. Each test has a workflow of its own, so its
// state starts empty.
describe("a grasp-workflow/2 workflow's state on the run host", () => {
  // Its workflows bind a model, as every sealed workflow does: approved
  // only once the organization has one, whichever tests ran before.
  beforeAll(async () => {
    await connectModels(`test-model-key-${crypto.randomUUID()}`, [
      allowedModel,
    ]);
  });

  afterAll(endLiveResourceRuns);

  it("keeps a step's state once it succeeded, which the next run reads, and nothing of a step its `if` skipped", async () => {
    const kept = await sealedWorkflow();
    await echoingMail(kept.mail.id, "m-1");
    const { source, sealed: withTable } = await generated(
      [
        remember,
        {
          id: "never",
          type: "call",
          if: { $expr: 'args.who === "nobody"' },
          connection: "mail",
          action: "mail.send",
          args: { to: { $expr: "args.who" }, subject: "skipped" },
          state: { never: true },
        },
      ],
      {
        schema: objectOf({
          ...readState.schema.fields,
          never: { kind: "boolean" },
        }),
        value: { ...readState.value, never: { $expr: "state.never ?? false" } },
      }
    );
    const first = await waitingRun(kept);
    const ranFirst = await ranAs(first, source, {
      engine: retryingEngine(),
      sealed: withTable,
    });
    await echoingMail(kept.mail.id, "m-2");
    // Started once the first ended: its start reads what that one kept.
    const second = await waitingRun(kept);
    const ranSecond = await ranAs(second, source, {
      engine: retryingEngine(),
      sealed: withTable,
    });
    const third = await waitingRun(kept);
    const ranThird = await ranAs(third, source, {
      engine: retryingEngine(),
      sealed: withTable,
    });
    expect({ ranFirst, ranSecond, ranThird }).toStrictEqual({
      // The snapshot of its start: nothing kept yet, whatever it keeps.
      ranFirst: {
        ended: {
          last: "none",
          previous: "none",
          runs: 0,
          kind: "none",
          never: false,
        },
        tampered: [],
      },
      // What the first's call answered, what it read then, and its count.
      ranSecond: {
        ended: {
          last: "m-1",
          previous: "none",
          runs: 1,
          kind: "visit",
          never: false,
        },
        tampered: [],
      },
      ranThird: {
        ended: {
          last: "m-2",
          previous: "m-1",
          runs: 2,
          kind: "visit",
          never: false,
        },
        tampered: [],
      },
    });
  });

  it("writes a step's state once, whichever activation replays it or runs it again", async () => {
    const kept = await sealedWorkflow();
    await echoingMail(kept.mail.id, "m-1");
    const { source, sealed: withTable } = await generated(
      [remember],
      readState
    );
    const runId = await waitingRun(kept);
    const journal = new Map<string, Journaled>();
    const ran: string[] = [];
    const first = await ranAs(runId, source, {
      engine: journalingEngine(journal, ran),
      sealed: withTable,
    });
    // A later activation replays the journaled step; one that lost the
    // journal runs it again, its call answering otherwise, its key the
    // same.
    const replayed = await ranAs(runId, source, {
      engine: journalingEngine(journal, ran),
      sealed: withTable,
    });
    await echoingMail(kept.mail.id, "m-2");
    const again = await ranAs(runId, source, {
      engine: retryingEngine(),
      sealed: withTable,
    });
    const next = await waitingRun(kept);
    const read = await ranAs(next, source, {
      engine: retryingEngine(),
      sealed: withTable,
    });
    const nothing = { last: "none", previous: "none", runs: 0, kind: "none" };
    expect({
      first,
      replayed,
      again,
      ran: ran.filter((name) => name.startsWith("remember:")).length,
      writes: await stateWrites(runId),
      // The first write's: the step run again wrote nothing.
      read: read.ended,
    }).toStrictEqual({
      first: { ended: nothing, tampered: [] },
      replayed: { ended: nothing, tampered: [] },
      again: { ended: nothing, tampered: [] },
      ran: 1,
      writes: 1,
      read: { last: "m-1", previous: "none", runs: 1, kind: "visit" },
    });
  });

  it("holds each value to its key's declared schema as the step records it, failing the step and keeping nothing of one that doesn't fit", async () => {
    const kept = await sealedWorkflow();
    await echoingMail(kept.mail.id, "m-1");
    /** `remember`, keeping `state` alone. */
    const keepingOnly = async (state: Record<string, unknown>) =>
      await generated([{ ...remember, state }], {
        schema: objectOf({
          who: { kind: "string" },
          id: { kind: "string" },
          label: { kind: "string" },
        }),
        value: {
          who: { $expr: 'state.who ?? "none"' },
          id: { $expr: 'state.profile?.id ?? "none"' },
          // Typed by the schema's output, `label` filled in: read as such.
          label: { $expr: 'state.badge?.label.toUpperCase() ?? "none"' },
        },
      });
    /** What a run of `state`'s step ended with, and what it wrote. */
    const ranKeeping = async (state: Record<string, unknown>) => {
      const { source, sealed: withTable } = await keepingOnly(state);
      const runId = await waitingRun(kept);
      const ran = await ranAs(runId, source, {
        engine: retryingEngine(),
        sealed: withTable,
      });
      return { ended: ran.ended, writes: await stateWrites(runId) };
    };
    const refused = {
      // What the mail answered is text: `runs` is an integer.
      notInteger: await ranKeeping({ runs: { $expr: "output.messageId" } }),
      // Not a reference to a person: it has a space.
      notPerson: await ranKeeping({ who: { $expr: '"not " + "a person"' } }),
      // A closed object with a key it doesn't declare, never stripped.
      extraKey: await ranKeeping({
        profile: { $expr: "({ id: output.messageId, extra: 1 })" },
      }),
    };
    const fits = await ranKeeping({
      who: "user_1",
      profile: { $expr: "({ id: output.messageId })" },
      badge: {},
    });
    const { source, sealed: withTable } = await keepingOnly({});
    const next = await waitingRun(kept);
    const read = await ranAs(next, source, {
      engine: retryingEngine(),
      sealed: withTable,
    });
    // Each call took effect before its record failed.
    const failed = { ended: "workflow.failed_after_effect", writes: 0 };
    expect({ refused, fits, read: read.ended }).toStrictEqual({
      refused: { notInteger: failed, notPerson: failed, extraKey: failed },
      // The one that fits: read back as it was kept, its defaults filled in.
      fits: { ended: { who: "none", id: "none", label: "none" }, writes: 1 },
      read: { who: "user_1", id: "m-1", label: "UNKNOWN" },
    });
  });

  it("reads a value an older version kept under another schema as never kept, which the version that kept it still reads", async () => {
    const kept = await sealedWorkflow();
    /** A version keeping `value` as `count` of `schema`, ending with what it read. */
    const version = async (schema: Record<string, unknown>, value: unknown) =>
      await generated(
        [{ ...remember, state: { count: value } }],
        {
          schema: objectOf({ read: { kind: "string" } }),
          value: { read: { $expr: "typeof state.count" } },
        },
        declared.permissions,
        { count: schema }
      );
    const v1 = await version({ kind: "string" }, "many");
    const v2 = await version({ kind: "number" }, 3);
    const runOf = async (built: Awaited<ReturnType<typeof generated>>) => {
      const runId = await waitingRun(kept);
      const ran = await ranAs(runId, built.source, {
        engine: retryingEngine(),
        sealed: built.sealed,
      });
      return ran.ended;
    };
    const wrote = await runOf(v1);
    const again = await runOf(v1);
    // v2 declares a number: the string v1 kept reads as never kept.
    const newer = await runOf(v2);
    expect({ wrote, again, newer }).toStrictEqual({
      wrote: { read: "undefined" },
      again: { read: "string" },
      newer: { read: "undefined" },
    });
  });

  it("keeps state from a step in each item of a loop, the last item's last", async () => {
    const kept = await sealedWorkflow();
    const { source, sealed: withTable } = await generated(
      [
        {
          id: "rows",
          type: "forEach",
          items: { $expr: "args.rows" },
          do: [
            {
              ...remember,
              args: { to: { $expr: "item" }, subject: "row" },
              state: { last: { $expr: "item" } },
            },
          ],
        },
      ],
      {
        schema: objectOf({ last: { kind: "string" } }),
        value: { last: { $expr: 'state.last ?? "none"' } },
      },
      declared.permissions,
      declared.state,
      rowsOf({ kind: "string" })
    );
    const withRows = (run: HostedSealedRun) =>
      withTable({ ...run, input: { rows: ["a", "b", "c"] } });
    const first = await waitingRun(kept);
    const ranFirst = await ranAs(first, source, {
      engine: retryingEngine(),
      sealed: withRows,
    });
    const second = await waitingRun(kept);
    const ranSecond = await ranAs(second, source, {
      engine: retryingEngine(),
      sealed: withRows,
    });
    expect({
      ranFirst,
      writes: await stateWrites(first),
      ranSecond,
    }).toStrictEqual({
      ranFirst: { ended: { last: "none" }, tampered: [] },
      // Each item's step writes under its own key.
      writes: 3,
      ranSecond: { ended: { last: "c" }, tampered: [] },
    });
  });
});
