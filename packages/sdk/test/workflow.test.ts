/* oxlint-disable require-await -- fakes of async interfaces answer right away */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createTestEngine } from "../src/testing.ts";
import { v, workflow, WorkflowError } from "../src/workflow.ts";
import type { DoOptions, Duration, StepRunner } from "../src/workflow.ts";

const noParams = {};

/** A workflow that runs `body` with the input it's given. */
const withStep = <Output>(
  body: (step: StepRunner, input: unknown) => Promise<Output>
) =>
  workflow(
    "sample",
    { params: noParams },
    async (step, { input }) => await body(step, input)
  );

/** A workflow with one money parameter, its default given. */
const priced = (minorUnits: number) =>
  workflow(
    "priced",
    {
      params: {
        limit: {
          label: "Limit",
          type: v.money().default({ minorUnits, currency: "EUR" }),
        },
      },
    },
    async (_step, { params }) => params.limit
  );

/** A workflow with one number parameter labelled `label`. */
const labelled = (label: string) =>
  workflow(
    "labelled",
    { params: { limit: { label, type: v.number().default(1) } } },
    async () => null
  );

/** A workflow declaring one parameter of `type`, as a thunk. */
const declared = (type: unknown) => () =>
  workflow(
    "typed",
    // @ts-expect-error -- a type is a `v` schema
    { params: { limit: { label: "Limit", type } } },
    async () => null
  );

/** What `work` came to: its answer, or its error's message. */
const settledOutcome = async (
  work: () => Promise<unknown>
): Promise<unknown> => {
  try {
    return await work();
  } catch (error) {
    return error instanceof Error ? error.message : error;
  }
};

describe("workflow definitions", () => {
  it("rejects an empty ID", () => {
    expect(() => workflow("", { params: noParams }, async () => null)).toThrow(
      expect.objectContaining({ code: "workflow.invalid_definition" })
    );
  });

  it("rejects a parameter whose type isn't a `v` schema with a default", () => {
    for (const type of [
      v.number(),
      v.number().optional(),
      { descriptor: { kind: "number" } },
      "number",
      undefined,
    ]) {
      expect(declared(type)).toThrow(
        expect.objectContaining({ code: "workflow.invalid_definition" })
      );
    }
    expect(declared(v.number().default(3))).not.toThrow();
  });

  it("rejects parameters past the bounds the platform keeps, such as a label over 200 characters", () => {
    expect(labelled("L".repeat(200)).metadata.params[0]?.label).toHaveLength(
      200
    );
    expect(() => labelled("L".repeat(201))).toThrow(
      expect.objectContaining({ code: "workflow.invalid_definition" })
    );
  });

  it("runs with a parameter's default, and with the value set, checked by its type", async () => {
    const run = async (params: Record<string, unknown>) =>
      await settledOutcome(
        async () =>
          await priced(500_000).run(createTestEngine({ params }).engine)
      );

    expect({
      unset: await run({}),
      set: await run({ limit: { minorUnits: 7, currency: "USD" } }),
      unfit: String(await run({ limit: 7 })).startsWith('Parameter "limit"'),
    }).toStrictEqual({
      unset: { minorUnits: 500_000, currency: "EUR" },
      set: { minorUnits: 7, currency: "USD" },
      unfit: true,
    });
  });

  it("checks its input by the schema it declares", async () => {
    const greeting = workflow(
      "greeting",
      { params: noParams, input: v.object({ who: v.string() }) },
      async (_step, { input }) => `Hello, ${input.who}`
    );
    const run = async (input: unknown) =>
      await settledOutcome(
        async () => await greeting.run(createTestEngine().engine, input)
      );

    expect({
      fits: await run({ who: "Ada" }),
      unfit: String(await run({ who: 7 })).startsWith("Input: at who"),
    }).toStrictEqual({ fits: "Hello, Ada", unfit: true });
  });
});

describe("step calls", () => {
  it("reject a bad name, a missing description, a bad key, bad retries or a bad timeout", async () => {
    const calls: [string, DoOptions][] = [
      ["has:colon", { description: "Go" }],
      ["go", { description: " " }],
      ["go", { description: "Go", key: "" }],
      ["go", { description: "Go", key: "x".repeat(200) }],
      ["go", { description: "Go", key: "\uD800" }],
      ["go", { description: "Go", retries: { limit: -1 } }],
      ["go", { description: "Go", retries: { limit: 1, delay: 1.5 } }],
      // More attempts than the platform's five, its first included.
      ["go", { description: "Go", retries: { limit: 5 } }],
      ["go", { description: "Go", timeout: "400 days" }],
      // Past an attempt's minute, though a sleep may wait it.
      ["go", { description: "Go", timeout: "61 seconds" }],
      ["go", { description: "Go", timeout: "15 minutes" }],
    ];

    for (const [name, options] of calls) {
      const definition = withStep(
        async (step) => await step.do(name, options, async () => 1)
      );
      // oxlint-disable-next-line no-await-in-loop -- each run is one case
      await expect(
        definition.run(createTestEngine().engine)
      ).rejects.toMatchObject({ code: "workflow.invalid_step_call" });
    }
  });

  it("take an attempt timeout of up to a minute, up to four retries, and longer sleeps", async () => {
    const { engine, steps } = createTestEngine();
    await withStep(async (step) => {
      await step.do(
        "go",
        { description: "Go", timeout: "1 minute", retries: { limit: 4 } },
        async () => 1
      );
      await step.sleep("pause", {
        description: "Pause",
        duration: "15 minutes",
      });
    }).run(engine);

    expect(steps.map(({ type }) => type)).toStrictEqual(["step", "sleep"]);
  });

  it("reject options of the wrong type before anything runs", async () => {
    const ran: string[] = [];
    // The engine tells a decision's people, never the code.
    const withAsk = {
      description: "Approve",
      from: "person:anna",
      timeout: "7 days",
      ask: async () => {
        ran.push("ask");
      },
    };
    const calls: ((step: StepRunner) => Promise<unknown>)[] = [
      async (step) =>
        await step.do(
          "go",
          // @ts-expect-error -- input is JSON
          { description: "Go", input: new Date(0) },
          async () => ran.push("go")
        ),
      async (step) =>
        await step.do(
          "go",
          // @ts-expect-error -- a step takes only the options it has
          { description: "Go", sideEffect: true },
          async () => ran.push("go")
        ),
      async (step) =>
        // @ts-expect-error -- a decision takes no `ask`
        await step.decision("approve", withAsk),
    ];

    for (const call of calls) {
      // oxlint-disable-next-line no-await-in-loop -- each run is one case
      await expect(
        withStep(call).run(createTestEngine().engine)
      ).rejects.toMatchObject({ code: "workflow.invalid_step_call" });
    }
    expect(ran).toStrictEqual([]);
  });

  it("run a step name once per run, or once per key", async () => {
    const once = { description: "Once" };
    const twice = withStep(async (step) => {
      await step.do("once", once, async () => 1);
      await step.do("once", once, async () => 2);
    });
    const perItem = withStep(async (step) => {
      for (const key of ["a", "b"]) {
        // oxlint-disable-next-line no-await-in-loop -- steps run in order
        await step.do("item", { ...once, key }, async () => key);
      }
      await step.do("item", { ...once, key: "a" }, async () => "again");
    });

    await expect(twice.run(createTestEngine().engine)).rejects.toThrow(
      "give each run of it its own key"
    );
    await expect(perItem.run(createTestEngine().engine)).rejects.toThrow(
      'already ran with key "a"'
    );
  });
});

describe("step.do", () => {
  it("gives each step its input, and nothing else", async () => {
    const received: unknown[] = [];
    const definition = withStep(async (step) => {
      await step.do(
        "read",
        { description: "Read", input: { id: 7 } },
        async (context) => {
          received.push(context);
        }
      );
      await step.do(
        "write",
        { description: "Write", key: 7 },
        async (context) => {
          received.push(context);
        }
      );
    });

    await definition.run(createTestEngine().engine);

    expect(received).toStrictEqual([
      { input: { id: 7 } },
      { input: undefined },
    ]);
  });

  it("reaches the run's bindings from inside a step", async () => {
    const sent: unknown[] = [];
    const env = {
      OUTLOOK: {
        call: async (...args: unknown[]) => {
          sent.push(args);
          return "sent";
        },
      },
    };
    const definition = workflow(
      "mailer",
      { params: noParams },
      async (step, context) =>
        await step.do(
          "mail",
          { description: "Mail", input: { to: "anna" } },
          async ({ input }) =>
            (await context.env.OUTLOOK?.call?.("mail.send", input)) ?? null
        )
    );

    const output = await definition.run(createTestEngine({ env }).engine);

    expect({ output, sent }).toStrictEqual({
      output: "sent",
      sent: [["mail.send", { to: "anna" }]],
    });
  });

  it("retries a step that fails for a passing cause as often as asked, and any other failure never", async () => {
    const failingWith = (error: () => unknown) => {
      let attempts = 0;
      return withStep(
        async (step) =>
          await step.do(
            "call",
            { description: "Call", retries: { limit: 2 } },
            async () => {
              attempts += 1;
              if (attempts < 3) {
                throw error();
              }
              return attempts;
            }
          )
      );
    };
    // As a connection's server answers a rate-limited call: nothing done.
    const rateLimited = failingWith(() =>
      Object.assign(new Error("Busy"), { code: "connect.server_unavailable" })
    );
    // As the model gateway answers while the provider limits requests:
    // nothing answered, and its rate comes back as its window passes.
    const limited = failingWith(() =>
      Object.assign(new Error("Limited"), { code: "model.rate_limited" })
    );
    // As an App's model binding answers while its budget is held so.
    const bindingHeld = failingWith(() =>
      Object.assign(new Error("Binding held"), {
        code: "resource.budget_busy",
      })
    );
    // A function's failed answer as `env.APP.callFunction` gives it, thrown
    // as it is (`throw answered.error`): plain data, its code kept.
    const answerHeld = failingWith((): unknown => ({
      code: "resource.budget_busy",
      message: "Answer held",
      category: "operational",
      retryable: true,
      requestId: "request-1",
    }));
    // As a tool reports bad input: trying again changes nothing.
    const refused = failingWith(() =>
      Object.assign(new Error("Refused"), { code: "connect.action_failed" })
    );
    const thrown = failingWith(() => new Error("No such customer"));

    const outcomeOf = async (definition: typeof thrown) =>
      await settledOutcome(
        async () => await definition.run(createTestEngine().engine)
      );
    expect({
      rateLimited: await outcomeOf(rateLimited),
      limited: await outcomeOf(limited),
      bindingHeld: await outcomeOf(bindingHeld),
      answerHeld: await outcomeOf(answerHeld),
      refused: await outcomeOf(refused),
      thrown: await outcomeOf(thrown),
    }).toStrictEqual({
      rateLimited: 3,
      limited: 3,
      bindingHeld: 3,
      answerHeld: 3,
      refused: "Refused",
      thrown: "No such customer",
    });
  });

  it("fails a step whose result isn't JSON, which an engine can't store", async () => {
    const definition = withStep(
      async (step) =>
        await step.do(
          "when",
          { description: "When" },
          // @ts-expect-error -- a step's result is JSON
          async () => new Date(0)
        )
    );

    await expect(definition.run(createTestEngine().engine)).rejects.toThrow(
      "isn't JSON"
    );
  });

  it("replays a step's stored result, whatever the run did to it since", async () => {
    const definition = withStep(async (step) => {
      const list = await step.do("list", { description: "List" }, async () => ({
        items: ["a"],
      }));
      list.items.push("added by the run");
      return list.items;
    });
    const { engine } = createTestEngine();

    await definition.run(engine);

    await expect(definition.run(engine)).resolves.toStrictEqual([
      "a",
      "added by the run",
    ]);
  });
});

describe("step.sleep", () => {
  it("hands the engine the sleep in milliseconds", async () => {
    const { engine, steps } = createTestEngine();

    await withStep(async (step) => {
      await step.sleep("pause", {
        description: "Pause",
        duration: "90 minutes",
      });
    }).run(engine);

    expect(steps).toStrictEqual([
      { type: "sleep", name: "pause", milliseconds: 5_400_000 },
    ]);
  });

  it("rejects a duration that isn't whole milliseconds, up to 365 days", async () => {
    const run = async (duration: unknown) => {
      await withStep(async (step) => {
        // @ts-expect-error -- durations are milliseconds or "<n> <unit>"
        await step.sleep("pause", { description: "Pause", duration });
      }).run(createTestEngine().engine);
    };

    const durations = [
      "soon",
      "-1 days",
      0,
      1.5,
      "366 days",
      Number.POSITIVE_INFINITY,
    ];
    for (const duration of durations) {
      // oxlint-disable-next-line no-await-in-loop -- each run is one case
      await expect(run(duration)).rejects.toMatchObject({
        code: "workflow.invalid_step_call",
      });
    }
  });
});

const decisionWorkflow = (limits: { timeout: Duration }) =>
  workflow(
    "decide",
    {
      params: {
        approver: {
          label: "Approver",
          type: v.person().default("person:anna"),
        },
      },
    },
    async (step, { params }) =>
      await step.decision("approve", {
        description: "Approve",
        from: params.approver,
        ...limits,
      })
  );

type Engine = ReturnType<typeof createTestEngine>["engine"];

/** `engine`, counting each time it tells a decision's people in `asked`. */
const counting = (engine: Engine, asked: string[]): Engine => ({
  ...engine,
  askDecision: async (decision) => {
    asked.push(decision);
    await engine.askDecision(decision);
  },
});

describe("step.decision", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out at its deadline when telling its people outlasts the timeout", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const asked: string[] = [];
    const { engine, steps } = createTestEngine();
    const slow: Engine = {
      ...engine,
      askDecision: async (decision) => {
        asked.push(decision);
        vi.setSystemTime(Date.now() + 2 * 86_400_000);
        await engine.askDecision(decision);
      },
    };

    await expect(
      decisionWorkflow({ timeout: "1 day" }).run(slow)
    ).resolves.toStrictEqual({ timedOut: true });
    expect(asked).toStrictEqual(["approve"]);
    // No time is left to wait: the decision is only closed.
    expect(
      steps.flatMap((record) =>
        record.type === "wait" ? [record.timeout] : []
      )
    ).toStrictEqual([0]);
  });

  it("refuses a decision without a timeout", async () => {
    const { engine } = createTestEngine();

    await expect(
      // @ts-expect-error -- the SDK owns how long a decision waits
      decisionWorkflow({}).run(engine)
    ).rejects.toMatchObject({ code: "workflow.invalid_step_call" });
  });

  it("opens a decision once, even when the step that opened it runs again", async () => {
    const { engine, decisions } = createTestEngine();
    let crashed = false;
    // The engine dies after opening the decision, before it records the step.
    const crashing = {
      ...engine,
      openDecision: async (
        ...request: Parameters<typeof engine.openDecision>
      ) => {
        const opened = await engine.openDecision(...request);
        if (!crashed) {
          crashed = true;
          throw new Error("Engine died before recording the step");
        }
        return opened;
      },
    };
    const definition = decisionWorkflow({ timeout: "7 days" });

    await expect(definition.run(crashing)).rejects.toThrow("Engine died");
    await definition.run(crashing);

    expect(decisions.map(({ step, from }) => ({ step, from }))).toStrictEqual([
      { step: "approve", from: "person:anna" },
    ]);
  });

  it("picks up a decision after the run was killed waiting for it, asking once", async () => {
    const asked: string[] = [];
    const { engine, decisions } = createTestEngine({
      decisions: { approve: { approved: true, by: "anna" } },
    });
    let killed = false;
    // The run is killed while it waits; the answer comes in meanwhile.
    const killedWhileWaiting = {
      ...counting(engine, asked),
      waitForDecision: async (
        ...wait: Parameters<typeof engine.waitForDecision>
      ) => {
        if (!killed) {
          killed = true;
          throw new Error("Run killed while waiting");
        }
        return await engine.waitForDecision(...wait);
      },
    };
    const definition = decisionWorkflow({ timeout: "7 days" });

    await expect(definition.run(killedWhileWaiting)).rejects.toThrow(
      "Run killed"
    );
    const outcome = await definition.run(killedWhileWaiting);
    const replayed = await definition.run(killedWhileWaiting);

    expect(outcome).toStrictEqual({
      timedOut: false,
      approved: true,
      by: "anna",
      payload: null,
    });
    expect(replayed).toStrictEqual(outcome);
    expect(asked).toStrictEqual(["approve"]);
    expect(decisions).toHaveLength(1);
  });

  it("passes on what the person sent with the answer", async () => {
    const { engine } = createTestEngine({
      decisions: {
        approve: { approved: false, by: "anna", payload: { comment: "No" } },
      },
    });

    await expect(
      decisionWorkflow({ timeout: "7 days" }).run(engine)
    ).resolves.toStrictEqual({
      timedOut: false,
      approved: false,
      by: "anna",
      payload: { comment: "No" },
    });
  });
});

describe("one step at a time", () => {
  it("refuses a step inside a step's function, again on replay, without retrying", async () => {
    let attempts = 0;
    let seen = false;
    const nested = withStep(async (step) => {
      await step.do(
        "outer",
        { description: "Outer", retries: { limit: 3 } },
        async () => {
          attempts += 1;
          await step.do("inner", { description: "Inner" }, async () => {
            seen = true;
          });
        }
      );
    });
    const { engine } = createTestEngine();

    await expect(nested.run(engine)).rejects.toMatchObject({
      code: "workflow.invalid_step_call",
    });
    await expect(nested.run(engine)).rejects.toMatchObject({
      code: "workflow.invalid_step_call",
    });
    expect(attempts).toBe(2);
    expect(seen).toBeFalsy();
  });

  it("refuses a step started while another runs", async () => {
    const ran: string[] = [];
    const inside = withStep(async (step) => {
      await step.do("outer", { description: "Outer" }, async () => {
        await step.do("inner", { description: "Inner" }, async () => {
          ran.push("inner");
        });
      });
    });
    const alongside = withStep(
      async (step) =>
        await Promise.all([
          step.do("first", { description: "First" }, async () => 1),
          step.do("second", { description: "Second" }, async () => 2),
        ])
    );

    for (const definition of [inside, alongside]) {
      // oxlint-disable-next-line no-await-in-loop -- each run is one case
      await expect(
        definition.run(createTestEngine().engine)
      ).rejects.toMatchObject({ code: "workflow.invalid_step_call" });
    }
    expect(ran).toStrictEqual([]);
  });
});

describe("errors", () => {
  it("keep their code through an engine that keeps only an error's name and message", async () => {
    const { engine } = createTestEngine({ params: { approver: "" } });
    const definition = workflow(
      "coded",
      {
        params: {
          approver: {
            label: "Approver",
            type: v.person().default("person:anna"),
          },
        },
      },
      async () => null
    );

    const failure: unknown = await definition
      .run(engine)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WorkflowError);
    expect(failure).toMatchObject({ code: "workflow.invalid_param" });
  });

  it("are read back from a name and message alone, and only when they are workflow errors", () => {
    const kept = new Error('Parameter "approver" is empty');
    kept.name = new WorkflowError("workflow.invalid_param", "x").name;
    const other = new Error("Ledger went away");

    expect(WorkflowError.from(kept)).toMatchObject({
      code: "workflow.invalid_param",
      message: kept.message,
    });
    expect(WorkflowError.from(other)).toBeUndefined();
  });
});
