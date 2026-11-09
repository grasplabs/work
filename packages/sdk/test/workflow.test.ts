/* oxlint-disable require-await -- fakes of async interfaces answer right away */
import { runIdSchema } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { describe, expect, it } from "vite-plus/test";

import type { WorkflowEngine } from "../src/engine.ts";
import { caughtError } from "../src/workflow-generated.ts";
import { AppError, defineWorkflow, v } from "../src/workflow.ts";

// The workflow runtime, from its threat model (workflow.ts): data a
// handler reads is frozen JSON with no prototype, on a first run and on a
// replay; `ctx`'s members are only what `permissions` declares, frozen,
// with no prototype and no `Proxy`; and every call journals itself under
// its step, by names that are the same on every replay, with no enter
// step for flow.

/** A call a fake binding was asked to make. */
interface Made {
  readonly binding: string;
  readonly operation: Json;
  readonly args: Json;
}

/** What `value` holds at `path`, as untyped code reads it. */
const read = (value: unknown, ...path: string[]): unknown => {
  let held = value;
  for (const key of path) {
    held =
      typeof held === "object" && held !== null
        ? Reflect.get(held, key)
        : undefined;
  }
  return held;
};

/** Whether `value` is frozen data: frozen, with no prototype. */
const isFrozenData = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  Object.isFrozen(value) &&
  Object.getPrototypeOf(value) === null;

/** `value`'s own fields, in a plain object, to compare. */
const fieldsOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};

/** Whether `value` is JSON, all the way down. */
const isJson = (value: unknown): value is Json => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item: unknown) => isJson(item));
  }
  return (
    typeof value === "object" &&
    Object.values(value).every((item: unknown) => isJson(item))
  );
};

/** JSON as an outside system answers it, `__proto__` keys and all. */
const parsed = (text: string): Json => {
  const value: unknown = JSON.parse(text);
  if (!isJson(value)) {
    throw new TypeError("Not JSON");
  }
  return value;
};

/** `value`'s own keys, if it is an object. */
const keysOf = (value: unknown): (string | symbol)[] =>
  typeof value === "object" && value !== null ? Reflect.ownKeys(value) : [];

/** A mail call's answer whose JSON names the prototype's own keys. */
const hostileAnswer = parsed(
  '{"id": "m-1", "__proto__": {"admin": true}, "constructor": {"prototype": 1}, "lines": [{"total": 3}, {"total": 9}]}'
);

/**
 * An in-memory engine: it journals each step's result by its name and
 * answers a journaled step from the journal, as a durable engine replays
 * one, never running it again. Bindings answer `answers[operation]`.
 */
const engineOf = ({
  journal = new Map<string, string>(),
  answers = new Map<Json, Json>(),
  failing = new Map<Json, { code: string; message: string }>(),
  state = {},
}: {
  journal?: Map<string, string>;
  answers?: ReadonlyMap<Json, Json>;
  failing?: ReadonlyMap<Json, { code: string; message: string }>;
  state?: Readonly<Record<string, Json>>;
} = {}) => {
  const names: string[] = [];
  const made: Made[] = [];
  const binding = (name: string) => ({
    call: async (operation: Json, args: Json): Promise<Json> => {
      made.push({ binding: name, operation, args });
      const failure = failing.get(operation);
      if (failure !== undefined) {
        throw Object.assign(new Error(failure.message), { code: failure.code });
      }
      return answers.get(operation) ?? null;
    },
  });
  const journaled = async <T>(
    name: string,
    run: () => Promise<T>
  ): Promise<T> => {
    names.push(name);
    const kept = journal.get(name);
    if (kept !== undefined) {
      // SAFETY: the journal holds what this step recorded, as JSON, which
      // is how a durable engine answers a replayed step.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      return JSON.parse(kept) as T;
    }
    const result = await run();
    journal.set(name, JSON.stringify(result ?? null));
    return result;
  };
  const engine: WorkflowEngine = {
    runId: runIdSchema.parse("run-1"),
    params: {},
    inbox: { replies: "reply-1@grasp.test" },
    state,
    env: { mail: binding("mail"), ai: binding("ai") },
    do: async (name, _options, fn) => await journaled(name, fn),
    sleep: async (name) => {
      await journaled(name, async () => null);
    },
    sleepUntil: async (name) => {
      await journaled(name, async () => null);
    },
    listen: async (name) =>
      await journaled(name, async () => ({
        timedOut: false,
        event: {
          id: "event-1",
          type: "grasp.reply.received",
          source: "grasp",
          time: "2026-11-09T00:00:00Z",
          data: parsed('{"__proto__": {"polluted": true}, "text": "Yes"}'),
        },
      })),
    openDecision: async () => ({ decision: "decision-1", deadline: 10 }),
    askDecision: async () => {},
    waitForDecision: async (name) =>
      await journaled(name, async () => ({
        answered: true,
        approved: true,
        by: "user-ada",
        payload: null,
      })),
  };
  return { engine, names, made, journal };
};

const permissions = {
  ai: true,
  connections: {
    mail: { send: "mail.send", "read-attachment": "mail.read-attachment" },
  },
  decisions: ["finance"],
  events: { replies: ["grasp.reply.received"] },
} as const;

describe("a workflow's data", () => {
  /** What a run of a mail and a wait reads, on a first run and on its replay. */
  const readsOf = async () => {
    const seen: unknown[] = [];
    const workflow = defineWorkflow({
      args: v.object({ who: v.string() }),
      permissions,
      handler: async (ctx, args) => {
        const sent: unknown = await ctx.connections.mail.send(
          { to: args.who },
          { step: "send" }
        );
        const reply: unknown = await ctx.events.replies.waitFor(
          { type: "grasp.reply.received", timeout: "3 days" },
          { step: "reply" }
        );
        seen.push({ args, sent, reply, ctx });
        return null;
      },
    });
    const first = engineOf({
      answers: new Map([["mail.send", hostileAnswer]]),
    });
    await workflow.run(first.engine, { who: "ada@example.com" });
    const replayed = engineOf({ journal: first.journal });
    await workflow.run(replayed.engine, { who: "ada@example.com" });
    return { seen, madeOnReplay: replayed.made };
  };

  it("is frozen JSON with no prototype, the first time and on replay", async () => {
    const { seen, madeOnReplay } = await readsOf();
    const values = seen.flatMap((run) => [
      read(run, "args"),
      read(run, "sent"),
      read(run, "reply"),
      ...["params", "state", "run", "inbox"].map((root) =>
        read(run, "ctx", root)
      ),
    ]);
    expect({
      madeOnReplay,
      count: values.length,
      notData: values.filter((value) => !isFrozenData(value)),
    }).toStrictEqual({ madeOnReplay: [], count: 14, notData: [] });
  });

  it("keeps `__proto__` and `constructor` keys as own fields holding data, never a prototype", async () => {
    const { seen } = await readsOf();
    const [, replayed] = seen;
    const sent = read(replayed, "sent");
    expect({
      ownProto: keysOf(sent).includes("__proto__"),
      inherited: read(sent, "admin"),
      constructorIsData: isFrozenData(read(sent, "constructor")),
      linesFrozen: Object.isFrozen(read(sent, "lines")),
      lineIsData: isFrozenData(read(sent, "lines", "0")),
      eventData: read(replayed, "reply", "event", "data", "polluted"),
      polluted: read({}, "admin"),
    }).toStrictEqual({
      ownProto: true,
      inherited: undefined,
      constructorIsData: true,
      linesFrozen: true,
      lineIsData: true,
      eventData: undefined,
      polluted: undefined,
    });
  });

  it("reads a caught failure as frozen data with no prototype, its code and message only", async () => {
    let caught: unknown;
    const workflow = defineWorkflow({
      permissions,
      handler: async (ctx) => {
        try {
          await ctx.connections.mail.send({}, { step: "send" });
        } catch (error) {
          caught = caughtError(error);
        }
        return null;
      },
    });
    const { engine } = engineOf({
      failing: new Map([
        ["mail.send", { code: "connect.unavailable", message: "Down." }],
      ]),
    });
    await workflow.run(engine, {});
    const raised = caughtError(
      new AppError("invoice.rejected", "No.", { id: 7 })
    );
    expect({
      caught: fieldsOf(caught),
      data: isFrozenData(caught),
      expression: fieldsOf(caughtError(new TypeError("Cannot read x of null"))),
      raised: { code: raised.code, message: raised.message },
      details: fieldsOf(read(raised, "details")),
    }).toStrictEqual({
      caught: { code: "connect.unavailable", message: "Down.", step: "send" },
      data: true,
      expression: {
        code: "expression.failed",
        message: "The expression failed.",
      },
      raised: { code: "invoice.rejected", message: "No." },
      details: { id: 7 },
    });
  });

  it("reads only the declared state keys whose values fit", async () => {
    let state: unknown;
    const workflow = defineWorkflow({
      state: { last: v.string(), count: v.number() },
      handler: async (ctx) => {
        ({ state } = ctx);
        return null;
      },
    });
    await workflow.run(
      engineOf({ state: { last: "m-1", count: "many", other: 1 } }).engine,
      {}
    );
    expect(fieldsOf(state)).toStrictEqual({ last: "m-1" });
  });
});

/** Paths into `ctx` that no declaration makes. */
const probes: readonly (readonly string[])[] = [
  ["connections", "github"],
  ["connections", "mail", "deleteEverything"],
  ["connections", "constructor"],
  ["connections", "__proto__"],
  ["decisions", "__proto__"],
  ["decisions", "finance"],
  ["ai"],
  ["constructor"],
  ["toString"],
];

/** The ctx a workflow declaring only `mail.send` gets. */
const declaredCtx = async (): Promise<unknown> => {
  let held: unknown;
  const workflow = defineWorkflow({
    permissions: { connections: { mail: { send: "mail.send" } } },
    handler: async (ctx) => {
      held = ctx;
      return null;
    },
  });
  await workflow.run(engineOf().engine, {});
  return held;
};

describe("a workflow's ctx", () => {
  it("has no member its permissions don't declare", async () => {
    const ctx = await declaredCtx();
    expect(
      probes.filter((path) => read(ctx, ...path) !== undefined)
    ).toStrictEqual([]);
  });

  it("builds its members as frozen objects with no prototype, never a Proxy", async () => {
    const ctx = await declaredCtx();
    const objects = [
      ctx,
      read(ctx, "connections"),
      read(ctx, "connections", "mail"),
    ];
    expect({
      data: objects.map((object) => isFrozenData(object)),
      // A Proxy would answer a name nobody declared; these answer none.
      anything: objects.map((object) => read(object, "anything")),
      aliases: keysOf(read(ctx, "connections")),
      actions: keysOf(read(ctx, "connections", "mail")),
    }).toStrictEqual({
      data: [true, true, true],
      anything: [undefined, undefined, undefined],
      aliases: ["mail"],
      actions: ["send"],
    });
  });

  it("makes each call as the declared action, its dotted name a path of members", async () => {
    const workflow = defineWorkflow({
      permissions,
      handler: async (ctx) => {
        await ctx.connections.mail.readAttachment({ id: 1 }, { step: "read" });
        await ctx.ai.generate(
          { instructions: "Sum up.", input: { id: 1 } },
          { step: "summary" }
        );
        return null;
      },
    });
    const { engine, made, names } = engineOf();
    await workflow.run(engine, {});
    expect({ made, names }).toStrictEqual({
      made: [
        { binding: "mail", operation: "mail.read-attachment", args: { id: 1 } },
        {
          binding: "ai",
          operation: "grasp.model",
          args: { instructions: "Sum up.", input: { id: 1 } },
        },
      ],
      names: ["$params", "read:task", "summary:task"],
    });
  });

  it.each([
    ["no options", undefined],
    ["no step", {}],
    ["a step that isn't an identifier", { step: "send-mail" }],
    ["a step naming a part", { step: "x:y" }],
  ])(
    "refuses a call with %s before anything is journaled",
    async (_case, options) => {
      const workflow = defineWorkflow({
        permissions,
        handler: async (ctx): Promise<unknown> =>
          await Reflect.apply(ctx.connections.mail.send, undefined, [
            {},
            options,
          ]),
      });
      const { engine, names } = engineOf();
      await expect(workflow.run(engine, {})).rejects.toMatchObject({
        code: "workflow.invalid_step_call",
      });
      expect(names).toStrictEqual(["$params"]);
    }
  );

  it("refuses a call started while another runs", async () => {
    const workflow = defineWorkflow({
      permissions,
      handler: async (ctx) =>
        await Promise.all([
          ctx.connections.mail.send({}, { step: "one" }),
          ctx.connections.mail.send({}, { step: "two" }),
        ]),
    });
    await expect(workflow.run(engineOf().engine, {})).rejects.toMatchObject({
      code: "workflow.invalid_step_call",
    });
  });
});

/** A handler as the generator writes one: flow in code, every call journaled. */
const generatedLike = defineWorkflow({
  args: v.object({ pages: v.array(v.object({ rows: v.array(v.string()) })) }),
  returns: v.object({ sent: v.number() }),
  state: { last: v.string() },
  permissions,
  handler: async (ctx, args) => {
    let sent = 0;
    for (const page of args.pages) {
      for (const row of page.rows) {
        if (row !== "") {
          // oxlint-disable-next-line no-await-in-loop -- a run's steps run one after another
          await ctx.connections.mail.send(
            { to: row },
            {
              step: "mailed",
              state: (output: { id: unknown }) => ({ last: output.id }),
            }
          );
          sent += 1;
        }
      }
    }
    const approval = await ctx.decisions.finance.ask(
      { recipients: ["role:finance"], prompt: "Fine?", input: { sent } },
      { step: "approve" }
    );
    if (approval.timedOut) {
      throw new AppError("invoice.unanswered", "Nobody answered.");
    }
    await ctx.sleepUntil(1000, { step: "until" });
    await ctx.events.replies.waitFor(
      {
        type: "grasp.reply.received",
        match: { field: "/to", equals: "ada" },
        timeout: "1 day",
      },
      { step: "reply" }
    );
    await ctx.sleep("1 hour", { step: "nap" });
    return { sent };
  },
});

const pages = { pages: [{ rows: ["a", "", "b"] }, { rows: ["c"] }] };

describe("a workflow's journal", () => {
  it("names each run of a step by its count, with no enter step for flow, the same on replay", async () => {
    const first = engineOf({
      answers: new Map([["mail.send", parsed('{"id": "m-1"}')]]),
    });
    const result = await generatedLike.run(first.engine, pages);
    const replayed = engineOf({ journal: first.journal });
    const again = await generatedLike.run(replayed.engine, pages);
    expect({
      result,
      again,
      names: first.names,
      replayedNames: replayed.names,
      madeOnReplay: replayed.made,
    }).toStrictEqual({
      result: { sent: 3 },
      again: { sent: 3 },
      names: [
        "$params",
        "mailed:task",
        "mailed:task@1",
        "mailed:task@2",
        "approve:enter",
        "approve:task",
        "approve:task#ask",
        "approve:task#asked",
        "approve:task#answer",
        "until:enter",
        "until:task",
        "reply:enter",
        "reply:task",
        "nap:task",
        "workflow:output",
      ],
      replayedNames: first.names,
      madeOnReplay: [],
    });
  });

  it("records each call with what it keeps, and a decision's ask as it was computed", async () => {
    const { engine, journal } = engineOf({
      answers: new Map([["mail.send", parsed('{"id": "m-1"}')]]),
    });
    await generatedLike.run(engine, pages);
    const recorded = (name: string): unknown =>
      JSON.parse(journal.get(name) ?? "null");
    expect({
      mailed: recorded("mailed:task"),
      approve: recorded("approve:enter"),
      reply: recorded("reply:enter"),
      until: recorded("until:enter"),
    }).toStrictEqual({
      mailed: { output: { id: "m-1" }, state: { last: "m-1" } },
      approve: {
        recipients: ["role:finance"],
        prompt: "Fine?",
        input: { sent: 3 },
      },
      reply: { key: "ada" },
      until: { output: null, until: 1000 },
    });
  });

  it("fails a step keeping a value its key's schema doesn't take, keeping nothing", async () => {
    const { engine, journal } = engineOf({
      answers: new Map([["mail.send", parsed('{"id": 7}')]]),
    });
    await expect(generatedLike.run(engine, pages)).rejects.toThrow(
      /State "last"/u
    );
    expect(journal.has("mailed:task")).toBeFalsy();
  });
});
