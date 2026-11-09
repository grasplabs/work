import { platformLimits } from "@grasp-os/shared/platform-limits";
import { workflowErrors } from "@grasp-os/shared/workflows";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { countedStep } from "../src/workflows/host.ts";
import type { HostedSealedRun } from "../src/workflows/sealed-run.ts";
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
  engineStep,
  hello,
  journalingEngine,
  person,
  ranAs,
  retryingEngine,
  reviewRun,
  sealedWorkflow,
  standardErrors,
  waitingRun,
} from "./sealed-run-harness.ts";
import type {
  Engine,
  Journaled,
  Reviewed,
  Sealed,
} from "./sealed-run-harness.ts";
import { unique } from "./sign-in.ts";
import {
  declared,
  generated,
  objectOf,
  rowsOf,
} from "./workflow-schema-runs.ts";

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
  // In a loop's item, a step's key goes on with the item's indexes.
  const of = (step: string): string | undefined =>
    keys.find((key) => key === step || key.startsWith(`${step}%40`));
  return {
    decided: keys.filter((key) => key.endsWith(":decide")).length,
    retried: keys.filter((key) => key.endsWith(":run")).length,
    failed: tries.get(of("key:fail:task") ?? ""),
    caught: of("key:guarded:catch") !== undefined,
    told: of("key:tell:task") !== undefined,
  };
};

const greeting = { kind: "object", fields: { line: { kind: "string" } } };

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
      input: objectOf({ who: { kind: "string" } }),
      output: {
        schema: objectOf({ status: { kind: "string" } }),
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

/** A step calling `broken`, which always fails. */
const fail = { id: "fail", type: "do", binding: "broken", arguments: 1 };

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
        type: "do",
        binding: "note",
        arguments: { to: { $expr: "error.type" } },
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

/** `decisionWorkflow`'s decision binding, as a document declares it. */
const approval = {
  approval: { kind: "decision", contract: "grasp.approvals@1" },
};

/** `decisionWorkflow`'s input: who reviews, and which invoice. */
const reviewing = objectOf({
  reviewer: { kind: "string" },
  invoice: { kind: "string" },
});

/** A decision of binding `approval` on input `{ reviewer, invoice }`. */
const review = (change: Record<string, unknown> = {}) => ({
  id: "review",
  type: "decision",
  binding: "approval",
  recipients: [{ $expr: "input.reviewer" }, "role:builder"],
  prompt: "Approve the invoice",
  input: { invoice: { $expr: "input.invoice" } },
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
    timedOut: { $expr: "steps.review.output.timedOut" },
    approved: { $expr: "steps.review.output.approved === true" },
    by: { $expr: 'steps.review.output.by ?? ""' },
    comment: { $expr: 'steps.review.output.payload?.comment ?? ""' },
  },
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
    const { source, sealed: withTable } = await generated(
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
          line: { kind: "string" },
          sent: { kind: "string" },
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

  it("runs a loop's items in order, a catch taking an item's raise, and stops where its `while` doesn't hold", async () => {
    const { source, sealed: withTable } = await generated(
      [
        {
          id: "rows",
          type: "forEach",
          items: { $expr: "input.rows" },
          while: { $expr: 'item !== "stop"' },
          do: [
            {
              id: "notify",
              type: "do",
              binding: "mail",
              operation: "mail.send",
              arguments: { to: { $expr: "item" }, subject: "row" },
            },
            {
              id: "guard",
              type: "try",
              try: [
                {
                  id: "check",
                  type: "raise",
                  if: { $expr: 'item === "b"' },
                  error: { type: "urn:grasp:error:bad", status: 409 },
                },
              ],
              catch: { errors: { status: 409 } },
            },
          ],
        },
      ],
      undefined,
      declared.bindings,
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
      // Item 2 is "stop": its item step records `while: false`, and no
      // step of it, nor of item 3, runs.
      sent: [
        { to: "a", subject: "row" },
        { to: "b", subject: "row" },
      ],
      checked: [
        `notify:${encodeURIComponent("task@0")}`,
        `notify:${encodeURIComponent("task@1")}`,
      ],
    });
  });

  it("replays a loop stopped after its first item's call: the same items, that call not made again, nothing refused", async () => {
    const { source, sealed: withTable } = await generated(
      [
        {
          id: "rows",
          type: "forEach",
          items: { $expr: "input.rows" },
          do: [
            {
              id: "notify",
              type: "do",
              binding: "mail",
              operation: "mail.send",
              arguments: { to: { $expr: "item" }, subject: "replayed row" },
            },
          ],
        },
      ],
      {
        schema: { kind: "array", item: { kind: "string" } },
        value: { $expr: "input.rows" },
      },
      declared.bindings,
      declared.state,
      rowsOf({ kind: "string" })
    );
    const runId = await waitingRun(sealed);
    const rows = (run: HostedSealedRun) =>
      withTable({ ...run, input: { rows: ["a", "b"] } });
    const journal = new Map<string, Journaled>();
    const second = engineStep("notify", "task@1");
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
      ranAgain: [second, engineStep("workflow", "output")],
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
          items: { $expr: "input.rows" },
          do: [
            {
              id: "notify",
              type: "do",
              if: { $expr: 'item !== "skip"' },
              binding: "mail",
              operation: "mail.send",
              arguments: { to: { $expr: "item" }, subject: "passed over" },
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
      declared.bindings,
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
      checked: [`notify:${encodeURIComponent("task@1")}`],
    });
  });

  it("fails the step of an `if` that throws as an item's first, which a catch in the item takes, refusing nothing", async () => {
    const { source, sealed: withTable } = await generated(
      [
        {
          id: "rows",
          type: "forEach",
          items: { $expr: "input.rows" },
          do: [
            {
              id: "guard",
              type: "try",
              try: [
                {
                  id: "notify",
                  type: "do",
                  // Item 0 is null: reading its `to` throws.
                  if: { $expr: 'item.to !== ""' },
                  binding: "mail",
                  operation: "mail.send",
                  arguments: { to: { $expr: "item.to" }, subject: "throwing" },
                },
              ],
              catch: {
                do: [
                  {
                    id: "report",
                    type: "do",
                    binding: "mail",
                    operation: "mail.send",
                    arguments: {
                      to: "ops",
                      subject: { $expr: 'error.type + " | " + error.title' },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
      undefined,
      declared.bindings,
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
      // The failure the host recorded of item 0's step: an expression's
      // (`expression.failed`), its type and the code's words; then item 1
      // runs. (Its guard's own message once the host keeps it.)
      sent: [
        {
          to: "ops",
          subject: `${standardErrors}expression | The expression failed.`,
        },
        { to: "a", subject: "throwing" },
      ],
      checked: [
        `report:${encodeURIComponent("task@0")}`,
        `notify:${encodeURIComponent("task@1")}`,
      ],
    });
  });

  it("records a list with a missing field as JSON, its item `null`, and runs its items", async () => {
    const { source, sealed: withTable } = await generated(
      [
        {
          id: "rows",
          type: "forEach",
          // `input.missing` isn't there: the list's item is `null`.
          items: { $expr: "[input.first, input.missing]" },
          do: [
            {
              id: "notify",
              type: "do",
              binding: "mail",
              operation: "mail.send",
              arguments: {
                to: { $expr: 'item ?? "nobody"' },
                subject: "listed",
              },
            },
          ],
        },
      ],
      undefined,
      declared.bindings,
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
          items: { $expr: "input.rows" },
          do: [
            {
              id: "notify",
              type: "do",
              binding: "mail",
              operation: "mail.send",
              arguments: { to: { $expr: "item" }, subject: "ceiling" },
            },
          ],
        },
      ],
      undefined,
      declared.bindings,
      declared.state,
      rowsOf({ kind: "string" })
    );
    const engine = retryingEngine();
    const ran = await ranAs(await waitingRun(sealed), source, {
      // A ceiling of 3 steps in place of the platform's: the loop's
      // enter step and two items' mail fit, the third item's doesn't.
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
      sent: ["a", "b"],
    });
  });

  it("fails a raise with its sealed error, which its catch takes, and skips a step whose `if` doesn't hold", async () => {
    const { source, sealed: withTable } = await generated(
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
        schema: objectOf({ skipped: { kind: "boolean" } }),
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
    const { source, sealed: withTable } = await generated([
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

  it("takes a deadline that fails to evaluate inside a retrying try as the expression's failure, not retried", async () => {
    const tries = new Map<string, number>();
    const { source, sealed: withTable } = await generated([
      {
        id: "guarded",
        type: "try",
        try: [
          // Reads past a field that isn't there: it throws.
          { id: "pause", type: "wait", until: { $expr: "input.missing.at" } },
        ],
        catch: {
          retry: {
            attempts: 2,
            delay: "1 second",
            backoff: "constant",
            when: { $expr: "error.status >= 400" },
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
      caught: tries.has("key:guarded:catch"),
    }).toStrictEqual({
      // An expression's failure (`expression.failed`) isn't one trying
      // again may fix: no round is offered, and the catch takes it.
      ran: { ended: null, tampered: [] },
      decided: 0,
      retried: 0,
      caught: true,
    });
  });
});

describe("a grasp-workflow/1 workflow's own modules on the run host", () => {
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
          total: { kind: "number" },
          told: { kind: "string" },
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
        caught: true,
        told: true,
      },
    };
    expect({
      // A number: the choice the host reads takes a boolean.
      booleans: await ranWith([
        guarded([fail], {
          catch: "error.status >= 400",
          retry: "error.status",
        }),
      ]),
      retryReadsThePage: await ranWith(
        inPages({ catch: "error.status >= 400", retry: "item.again" })
      ),
      catchReadsThePage: await ranWith(inPages({ catch: "item.again" })),
    }).toStrictEqual({
      booleans: retriedThenCaught,
      retryReadsThePage: retriedThenCaught,
      catchReadsThePage: retriedThenCaught,
    });
  });

  it("takes a retry `when` that throws as not retrying, the failure recorded and caught", async () => {
    const tries = new Map<string, number>();
    const { source, sealed: withTable } = await generated(
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

// A decision's generated code on the run host (#1923): the deciders its
// enter step records, `from` exactly the first of them, the run's own
// person never answering, a timeout answering `{ timedOut: true }`, and
// a decision in each item of a loop under that item's keys.
describe("a grasp-workflow/1 decision's generated code on the run host", () => {
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
          type: "decision",
          binding: "approval",
          recipients: [{ $expr: "input.reviewer" }],
          prompt,
          input: { invoice: { $expr: "input.invoice" } },
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
          step: `sign:${encodeURIComponent("task@0")}`,
          input: JSON.stringify({ invoice: "INV-1" }),
          status: "approved",
        },
        {
          step: `sign:${encodeURIComponent("task@1")}`,
          input: JSON.stringify({ invoice: "INV-2" }),
          status: "approved",
        },
      ],
    });
  });
});
