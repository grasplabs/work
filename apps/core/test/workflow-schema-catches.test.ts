import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { workflowStateOf } from "../src/workflow-state.ts";
import { endLiveResourceRuns } from "./json-workflow-apps.ts";
import {
  anyText,
  checkedCalls,
  failedWith,
  ranAs,
  retryingEngine,
  waitingRun,
} from "./sealed-run-harness.ts";
import type { Tries } from "./sealed-run-harness.ts";
import {
  fail,
  generated,
  local,
  localWorkflow,
  objectOf,
} from "./workflow-schema-runs.ts";

// grasp-workflow/2's tries, catches and retries as their generated code
// runs on the run host, one inside another: the innermost catch that
// takes a failure has it, before any retry further out; a catch that
// doesn't take it throws it on to the next; and an object's value left
// out where its expression gave nothing, as JSON leaves it out.

/** A retry of 3 attempts, a second apart. */
const thrice = { attempts: 3, delay: "1 second", backoff: "constant" };

/** Step `id` noting `error.code` through action `note`: a catch's recovery. */
const noting = (id: string) => ({
  id,
  type: "call",
  module: "note",
  args: { to: { $expr: "error.code" } },
});

/** Try `id` around `inside`, with `catch`. */
const trying = (id: string, inside: unknown[], caught: unknown) => ({
  id,
  type: "try",
  try: inside,
  catch: caught,
});

/**
 * Step `remarked` passing `note` to action `remark`, and keeping the
 * run's optional `note` in state.
 */
const remarking = (note: unknown) => [
  {
    id: "remarked",
    type: "call",
    module: "remark",
    args: { to: { $expr: "args.who" }, note },
    state: { note: { $expr: "args.note" } },
  },
];

/**
 * What an engine ran, by `tries`: each step's attempts by its engine name,
 * and the retry rounds the host decided and ran.
 */
const ranSteps = (tries: Tries) => {
  const keys = [...tries.keys()];
  return {
    steps: Object.fromEntries(
      keys
        .filter((key) => key.endsWith(":task") || key.includes(":task@"))
        .map((key) => [key.slice("key:".length), tries.get(key)])
    ),
    decided: keys.filter((key) => key.endsWith(":decide")).length,
    retried: keys.filter((key) => key.endsWith(":run")).length,
  };
};

describe("a grasp-workflow/2 workflow's nested tries on the run host", () => {
  let owned: Awaited<ReturnType<typeof localWorkflow>>;

  beforeAll(async () => {
    owned = await localWorkflow();
  });

  afterAll(endLiveResourceRuns);

  /** `steps` run on the host: its run, and how it ended and what ran. */
  const runOf = async (
    steps: unknown[],
    {
      output,
      state,
      input,
    }: {
      output?: { schema: unknown; value: unknown };
      state?: Record<string, unknown>;
      input?: unknown;
    } = {}
  ) => {
    const tries: Tries = new Map();
    const { source, sealed: withTable } = await generated(
      steps,
      output,
      local,
      state,
      input
    );
    const runId = await waitingRun(owned);
    const ran = await ranAs(runId, source, {
      engine: retryingEngine(tries),
      sealed: withTable,
    });
    return { runId, outcome: { ran, ...ranSteps(tries) } };
  };

  it("lets the innermost catch that takes a failure have it before a retry further out", async () => {
    const caught = async (inner: unknown) => {
      const { outcome } = await runOf([
        trying("outer", [trying("inner", [fail], inner)], {
          retry: thrice,
          do: [noting("retold")],
        }),
      ]);
      return outcome;
    };
    expect({
      // Its `when` holds: its recovery runs once, the call made once.
      conditional: await caught({
        when: { $expr: "true" },
        do: [noting("told")],
      }),
      // It takes every failure, or its code is the failure's: the same,
      // by the host alone.
      unconditional: await caught({ do: [noting("told")] }),
      byCode: await caught({
        code: "workflow.compute_failed",
        do: [noting("told")],
      }),
      // Its `when` holds, but its code isn't the failure's: the outer try
      // retries, then takes it.
      otherCode: await caught({
        code: "test.other",
        when: { $expr: "true" },
        do: [noting("told")],
      }),
      // Its `when` doesn't hold: the outer try retries, then takes it.
      declines: await caught({
        when: { $expr: 'error.code === "test.other"' },
        do: [noting("told")],
      }),
    }).toStrictEqual({
      // The host asks its code, which says no retry: the inner catch takes it.
      conditional: {
        ran: { ended: null, tampered: [] },
        steps: { "fail:task": 1, "told:task": 1 },
        decided: 1,
        retried: 0,
      },
      unconditional: {
        ran: { ended: null, tampered: [] },
        steps: { "fail:task": 1, "told:task": 1 },
        decided: 0,
        retried: 0,
      },
      byCode: {
        ran: { ended: null, tampered: [] },
        steps: { "fail:task": 1, "told:task": 1 },
        decided: 0,
        retried: 0,
      },
      otherCode: {
        ran: { ended: null, tampered: [] },
        steps: { "fail:task": 1, "retold:task": 1 },
        decided: 2,
        retried: 2,
      },
      declines: {
        ran: { ended: null, tampered: [] },
        steps: { "fail:task": 1, "retold:task": 1 },
        decided: 2,
        retried: 2,
      },
    });
  });

  it("retries by the inner try until its rounds are spent, its catch's raise then the outer catch's, and throws on what a catch's `when` declines", async () => {
    const exhausted = await runOf([
      trying(
        "outer",
        [
          trying("inner", [fail], {
            retry: thrice,
            do: [
              {
                id: "exhausted",
                type: "raise",
                error: { code: "test.exhausted", message: "Exhausted." },
              },
            ],
          }),
        ],
        { code: "test.exhausted", do: [noting("told")] }
      ),
    ]);
    const declined = await runOf([
      trying("outer", [trying("inner", [fail], { when: { $expr: "false" } })], {
        do: [noting("told")],
      }),
    ]);
    const told = await checkedCalls(declined.runId);
    expect({
      exhausted: exhausted.outcome,
      declined: { ...declined.outcome, told: told.map(({ step }) => step) },
    }).toStrictEqual({
      exhausted: {
        ran: { ended: null, tampered: [] },
        steps: { "fail:task": 1, "told:task": 1 },
        decided: 2,
        retried: 2,
      },
      // The inner catch throws the failure on as it was: the outer one
      // takes it, its code the call's.
      declined: {
        ran: { ended: null, tampered: [] },
        steps: { "fail:task": 1, "told:task": 1 },
        decided: 0,
        retried: 0,
        told: ["fail:task", "told:task"],
      },
    });
  });

  it("takes each item's failure in a loop's own catch, under that item's names, and retries a call in a loop by the try around it", async () => {
    const items = { $expr: "[1, 2]" };
    const eachItem = await runOf([
      {
        id: "rows",
        type: "forEach",
        items,
        do: [trying("row", [fail], { do: [noting("told")] })],
      },
    ]);
    const aroundLoop = await runOf([
      trying("outer", [{ id: "rows", type: "forEach", items, do: [fail] }], {
        retry: thrice,
        do: [noting("told")],
      }),
    ]);
    expect({
      eachItem: eachItem.outcome,
      // The first item's call retried, then caught: the loop ends there.
      aroundLoop: aroundLoop.outcome,
    }).toStrictEqual({
      eachItem: {
        ran: { ended: null, tampered: [] },
        steps: {
          "fail:task": 1,
          "told:task": 1,
          "fail:task@1": 1,
          "told:task@1": 1,
        },
        decided: 0,
        retried: 0,
      },
      aroundLoop: {
        ran: { ended: null, tampered: [] },
        steps: { "fail:task": 1, "told:task": 1 },
        decided: 2,
        retried: 2,
      },
    });
  });

  it("fails the run with what no catch may take, however many tries stand around it", async () => {
    const tries: Tries = new Map();
    const { source, sealed: withTable } = await generated(
      [
        trying(
          "outer",
          [
            trying("inner", [{ id: "linger", type: "wait", for: "1 hour" }], {
              when: { $expr: "true" },
              do: [noting("told")],
            }),
          ],
          { retry: thrice, do: [noting("retold")] }
        ),
      ],
      undefined,
      local
    );
    const ran = await ranAs(await waitingRun(owned), source, {
      engine: retryingEngine(tries),
      sealed: withTable,
      // A test run's waits are held to a minute: an hour's is past it.
      maxSleepMs: 60_000,
    });
    expect({ ran, ...ranSteps(tries) }).toStrictEqual({
      ran: failedWith("workflow.candidate_wait_limit"),
      steps: {},
      decided: 0,
      retried: 0,
    });
  });

  it("leaves out an object's value whose expression gave nothing, as JSON does, and refuses a literal left out", async () => {
    const optional = {
      input: objectOf({
        who: { kind: "string" },
        note: { kind: "string", optional: true },
      }),
      state: { note: { kind: "string", optional: true } },
    };
    // What the action was given, as it answers.
    const output = {
      schema: objectOf({ given: { kind: "array", item: { kind: "string" } } }),
      value: { given: { $expr: "remarked.given" } },
    };
    const absent = await runOf(remarking({ $expr: "args.note" }), {
      ...optional,
      output,
    });
    // The literal's key taken out of the code: the build sealed it.
    const { source, sealed: withTable } = await generated(
      remarking("by hand"),
      output,
      local,
      optional.state,
      optional.input
    );
    const forged = source.replace(",note:`by hand`", "");
    const tampered = await ranAs(await waitingRun(owned), forged, {
      engine: retryingEngine(),
      sealed: withTable,
    });
    expect({
      absent: absent.outcome.ran,
      state: await workflowStateOf(env, owned.workflow.id),
      forged: forged !== source,
      tampered,
    }).toStrictEqual({
      // The action was given no `note`, and the step kept nothing.
      absent: { ended: { given: ["to"] }, tampered: [] },
      state: {},
      forged: true,
      tampered: {
        ended: "workflow.invalid",
        why: anyText,
        tampered: ["workflow.invalid"],
      },
    });
  });
});
