import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { workflowStateOf } from "../src/workflow-state.ts";
import { endLiveResourceRuns } from "./json-workflow-apps.ts";
import { answeringProvider, connectModels } from "./model-provider.ts";
import type { SentRequest } from "./model-provider.ts";
import {
  allowedModel,
  anyText,
  checkedCalls,
  failedWith,
  hello,
  ranAs,
  retryingEngine,
  sealedWorkflow,
  waitingRun,
} from "./sealed-run-harness.ts";
import type { Sealed, Tries } from "./sealed-run-harness.ts";
import {
  fail,
  generated,
  objectOf,
  unavailable,
} from "./workflow-schema-runs.ts";

// grasp-workflow/2's tries, catches and retries as their generated code
// runs on the run host, one inside another: the innermost catch that
// takes a failure has it, before any retry further out; a catch that
// doesn't take it throws it on to the next; and an object's value left
// out where its expression gave nothing, as JSON leaves it out. The step
// that fails mails through a server that is unavailable: the engine tries
// it three times a round.

/** A retry of 3 attempts, a second apart. */
const thrice = { attempts: 3, delay: "1 second", backoff: "constant" };

const greeting = objectOf({ line: { kind: "string" } });

/** Step `id` asking the model about `error.code`: a catch's recovery. */
const noting = (id: string) => ({
  id,
  type: "generate",
  instructions: "Say what went wrong.",
  input: { code: { $expr: "error.code" } },
  returns: greeting,
});

/** Try `id` around `inside`, with `catch`. */
const trying = (id: string, inside: unknown[], caught: unknown) => ({
  id,
  type: "try",
  try: inside,
  catch: caught,
});

/**
 * Step `remarked` asking the model with the run's `who` and `note`, and
 * keeping the run's optional `note` in state.
 */
const remarking = (note: unknown) => [
  {
    id: "remarked",
    type: "generate",
    instructions: "Remark on it.",
    input: { who: { $expr: "args.who" }, note },
    returns: greeting,
    state: { note: { $expr: "args.note" } },
  },
];

/** The object a request sent the model as its input: one with a `who`. */
const inputOf = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value === "string") {
    try {
      return inputOf(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) && "who" in value) {
    return Object.fromEntries(Object.entries(value));
  }
  for (const each of Object.values(value)) {
    const found = inputOf(each);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
};

/** The model's answer: the keys of the input it was given, or a greeting. */
const givenKeys = (requests: readonly SentRequest[]) => {
  const input = inputOf(requests.at(-1)?.body);
  if (input === undefined) {
    return hello;
  }
  const line = Object.keys(input).toSorted().join(",");
  return { ...hello, text: JSON.stringify({ line }) };
};

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
  let failing: Sealed;

  beforeAll(async () => {
    await connectModels(`test-model-key-${crypto.randomUUID()}`, [
      allowedModel,
    ]);
    failing = await sealedWorkflow();
    await unavailable(failing);
    await answeringProvider(givenKeys, { models: [allowedModel] });
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
      undefined,
      state,
      input
    );
    const runId = await waitingRun(failing);
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
        code: "connect.server_unavailable",
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
        steps: { "fail:task": 3, "told:task": 1 },
        decided: 1,
        retried: 0,
      },
      unconditional: {
        ran: { ended: null, tampered: [] },
        steps: { "fail:task": 3, "told:task": 1 },
        decided: 0,
        retried: 0,
      },
      byCode: {
        ran: { ended: null, tampered: [] },
        steps: { "fail:task": 3, "told:task": 1 },
        decided: 0,
        retried: 0,
      },
      otherCode: {
        ran: { ended: null, tampered: [] },
        steps: { "fail:task": 3, "retold:task": 1 },
        decided: 2,
        retried: 2,
      },
      declines: {
        ran: { ended: null, tampered: [] },
        steps: { "fail:task": 3, "retold:task": 1 },
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
        steps: { "fail:task": 3, "told:task": 1 },
        decided: 2,
        retried: 2,
      },
      // The inner catch throws the failure on as it was: the outer one
      // takes it, its code the call's.
      declined: {
        ran: { ended: null, tampered: [] },
        steps: { "fail:task": 3, "told:task": 1 },
        decided: 0,
        retried: 0,
        told: ["fail:task", "fail:task", "fail:task", "told:task"],
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
          "fail:task": 3,
          "told:task": 1,
          "fail:task@1": 3,
          "told:task@1": 1,
        },
        decided: 0,
        retried: 0,
      },
      aroundLoop: {
        ran: { ended: null, tampered: [] },
        steps: { "fail:task": 3, "told:task": 1 },
        decided: 2,
        retried: 2,
      },
    });
  });

  it("fails the run with what no catch may take, however many tries stand around it", async () => {
    const tries: Tries = new Map();
    const { source, sealed: withTable } = await generated([
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
    ]);
    const ran = await ranAs(await waitingRun(failing), source, {
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
    // The keys of the input the model was given, as it answers.
    const output = {
      schema: objectOf({ given: { kind: "string" } }),
      value: { given: { $expr: "remarked.line" } },
    };
    const absent = await runOf(remarking({ $expr: "args.note" }), {
      ...optional,
      output,
    });
    // The literal's key taken out of the code: the build sealed it.
    const { source, sealed: withTable } = await generated(
      remarking("by hand"),
      output,
      undefined,
      optional.state,
      optional.input
    );
    const forged = source.replace(",note:`by hand`", "");
    const tampered = await ranAs(await waitingRun(failing), forged, {
      engine: retryingEngine(),
      sealed: withTable,
    });
    expect({
      absent: absent.outcome.ran,
      state: await workflowStateOf(env, failing.workflow.id),
      forged: forged !== source,
      tampered,
    }).toStrictEqual({
      // The model was given no `note`, and the step kept nothing.
      absent: { ended: { given: "who" }, tampered: [] },
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
