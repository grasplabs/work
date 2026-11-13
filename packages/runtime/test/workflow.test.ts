/* oxlint-disable require-await -- fakes of async interfaces answer right away */
import { runIdSchema } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { describe, expect, it } from "vite-plus/test";

import type { WorkflowEngine } from "../src/engine.ts";
import { caughtError, parse } from "../src/workflow-generated.ts";
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
  /** A connection call's files permissions, when it sent any. */
  readonly files?: Json;
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

/** When the fake engine's run started, in ms since the epoch. */
const startedAt = Date.UTC(2026, 10, 9, 8, 30);

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
    call: async (operation: Json, args: Json, files?: Json): Promise<Json> => {
      made.push({
        binding: name,
        operation,
        args,
        ...(files === undefined ? {} : { files }),
      });
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
    startedAt,
    params: {},
    inbox: { replies: "reply-1@grasp.test" },
    state,
    env: {
      mail: binding("mail"),
      ai: binding("ai"),
      runFiles: binding("runFiles"),
      handbook: binding("handbook"),
      notes: binding("notes"),
    },
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
    mail: { send: "mail.send", readAttachment: "mail.read-attachment" },
  },
  decisions: ["finance"],
  events: { replies: ["grasp.reply.received"] },
} as const;

/** JSON text of `levels` levels: lists around a leaf. */
const nested = (levels: number): string =>
  `${"[".repeat(levels - 1)}0${"]".repeat(levels - 1)}`;

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

  it("parses text into frozen data with no prototype, `__proto__` an own field", () => {
    const value: unknown = parse(
      '{"__proto__": {"admin": true}, "constructor": {"x": 1}, "lines": [{"a": 1}]}'
    );
    const scalar: unknown = parse("7");
    expect({
      data: isFrozenData(value),
      ownProto: keysOf(value).includes("__proto__"),
      inherited: read(value, "admin"),
      constructorIsData: isFrozenData(read(value, "constructor")),
      linesFrozen: Object.isFrozen(read(value, "lines")),
      lineIsData: isFrozenData(read(value, "lines", "0")),
      polluted: read({}, "admin"),
      scalar,
    }).toStrictEqual({
      data: true,
      ownProto: true,
      inherited: undefined,
      constructorIsData: true,
      linesFrozen: true,
      lineIsData: true,
      polluted: undefined,
      scalar: 7,
    });
    // Only text parses: anything else fails the expression, as JSON's own
    // parse fails on what isn't JSON.
    expect(() => {
      parse({ toString: () => "{}" });
    }).toThrow(TypeError);
    expect(() => {
      parse("{");
    }).toThrow(SyntaxError);
  });

  it("parses text nested as deep as any value may be, and refuses deeper", () => {
    expect(Object.isFrozen(parse(nested(32)))).toBeTruthy();
    expect(() => {
      parse(nested(33));
    }).toThrow(RangeError);
    // Far past it, as text from outside may be: refused, never walked.
    expect(() => {
      parse(nested(100_000));
    }).toThrow(RangeError);
  });

  it("knows when its run started, as frozen data, the same on replay", async () => {
    const seen: unknown[] = [];
    const workflow = defineWorkflow({
      handler: async (ctx) => {
        seen.push(ctx.run);
        return null;
      },
    });
    const first = engineOf({});
    await workflow.run(first.engine, {});
    const replayed = engineOf({ journal: first.journal });
    await workflow.run(replayed.engine, {});
    const [started, again] = seen;
    expect({
      data: isFrozenData(started),
      startedAt: read(started, "startedAt"),
      again: read(again, "startedAt"),
    }).toStrictEqual({
      data: true,
      startedAt,
      again: startedAt,
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
  ["apps", "notes"],
  ["apps", "constructor"],
  ["apps", "__proto__"],
  ["ai"],
  ["files", "runFiles"],
  ["files", "__proto__"],
  ["brain", "handbook"],
  ["brain", "constructor"],
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

  it("calls an App's function by its stable ID through its alias, its path a path of members", async () => {
    let apps: unknown;
    const workflow = defineWorkflow({
      permissions: {
        apps: {
          notes: { "notes.create": "fn-create", "notes.titles": "fn-titles" },
        },
      },
      handler: async (ctx) => {
        ({ apps } = ctx);
        await ctx.apps.notes.notes.create({ title: "Hi" }, { step: "made" });
        return null;
      },
    });
    const { engine, made, names } = engineOf();
    await workflow.run(engine, {});
    expect({
      made,
      names,
      // Only what was declared, frozen, with no prototype: no other
      // function, and nothing inherited.
      frozen: [
        isFrozenData(read(apps, "notes")),
        isFrozenData(read(apps, "notes", "notes")),
      ],
      functions: keysOf(read(apps, "notes", "notes")),
      undeclared: [
        read(apps, "notes", "notes", "remove"),
        read(apps, "notes", "constructor"),
        read(apps, "crm"),
      ],
    }).toStrictEqual({
      made: [
        { binding: "notes", operation: "fn-create", args: { title: "Hi" } },
      ],
      names: ["$params", "made:task"],
      frozen: [true, true],
      functions: ["create", "titles"],
      undeclared: [undefined, undefined, undefined],
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

  it("has only the files and Brain actions its steps take, as frozen members", async () => {
    let held: unknown;
    const workflow = defineWorkflow({
      permissions: {
        files: { runFiles: ["read"] },
        brain: { handbook: ["recall"] },
      },
      handler: async (ctx) => {
        held = ctx;
        return null;
      },
    });
    await workflow.run(engineOf().engine, {});
    const members = [
      read(held, "files"),
      read(held, "files", "runFiles"),
      read(held, "brain", "handbook"),
    ];
    expect({
      data: members.map((member) => isFrozenData(member)),
      files: keysOf(read(held, "files", "runFiles")),
      brain: keysOf(read(held, "brain", "handbook")),
      // An action no step takes is no member: deleting, writing, an action
      // the Brain doesn't have, or a name of the prototype's.
      undeclared: [
        read(held, "files", "runFiles", "delete"),
        read(held, "files", "runFiles", "write"),
        read(held, "brain", "handbook", "search"),
        read(held, "files", "runFiles", "constructor"),
        read(held, "brain", "__proto__"),
      ],
    }).toStrictEqual({
      data: [true, true, true],
      files: ["read"],
      brain: ["recall"],
      undeclared: [undefined, undefined, undefined, undefined, undefined],
    });
  });

  it("calls files and Brain actions through their permission, and sends a connection's files permissions only when it names them", async () => {
    const workflow = defineWorkflow({
      permissions: {
        connections: {
          mail: { readAttachment: "mail.readAttachment", send: "mail.send" },
        },
        files: { runFiles: ["read"] },
        brain: { handbook: ["recall"] },
      },
      handler: async (ctx) => {
        await ctx.connections.mail.readAttachment(
          { attachment: "a1" },
          { step: "kept", into: "runFiles" }
        );
        await ctx.connections.mail.send(
          { attachments: [{ file: "f1" }] },
          { step: "forwarded", from: "runFiles" }
        );
        await ctx.connections.mail.send({ to: "ada" }, { step: "plain" });
        await ctx.files.runFiles.read({ file: "f1" }, { step: "notes" });
        await ctx.brain.handbook.recall(
          { question: "refunds", budget: { tokens: 800 } },
          { step: "found" }
        );
        return null;
      },
    });
    const { engine, made } = engineOf();
    await workflow.run(engine, {});
    expect(made).toStrictEqual([
      {
        binding: "mail",
        operation: "mail.readAttachment",
        args: { attachment: "a1" },
        files: { into: "runFiles" },
      },
      {
        binding: "mail",
        operation: "mail.send",
        args: { attachments: [{ file: "f1" }] },
        files: { from: "runFiles" },
      },
      { binding: "mail", operation: "mail.send", args: { to: "ada" } },
      { binding: "runFiles", operation: "read", args: { file: "f1" } },
      {
        binding: "handbook",
        operation: "recall",
        args: { question: "refunds", budget: { tokens: 800 } },
      },
    ]);
  });

  it("refuses files permissions that aren't names, before anything is journaled", async () => {
    const workflow = defineWorkflow({
      permissions: { connections: { mail: { send: "mail.send" } } },
      handler: async (ctx): Promise<unknown> =>
        await Reflect.apply(ctx.connections.mail.send, undefined, [
          {},
          { step: "send", into: { alias: "runFiles" } },
        ]),
    });
    const { engine, names } = engineOf();
    await expect(workflow.run(engine, {})).rejects.toMatchObject({
      code: "workflow.invalid_step_call",
    });
    expect(names).toStrictEqual(["$params"]);
  });

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
  state: {
    last: v.string(),
    badge: v.object({ tone: v.string().default("plain") }),
  },
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
              // A value its schema fills defaults into is kept as written.
              state: (output: { id: unknown }) => ({
                last: output.id,
                badge: {},
              }),
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

  it("uses no run of a step for a call that fails before it journals anything", async () => {
    const workflow = defineWorkflow({
      permissions,
      handler: async (ctx) => {
        for (const args of [{ late: 1n }, { id: 1 }, { id: 2 }]) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- calls run one after another
            await ctx.connections.mail.send(args, { step: "send" });
          } catch {
            // The BigInt one isn't JSON: it fails before its step runs.
          }
        }
        return null;
      },
    });
    const { engine, names } = engineOf();
    await workflow.run(engine, {});
    expect(names).toStrictEqual(["$params", "send:task", "send:task@1"]);
  });

  it("throws on from every catch a failure the run host says no catch may take", async () => {
    let went = false;
    const workflow = defineWorkflow({
      permissions,
      handler: async (ctx) => {
        try {
          await ctx.connections.mail.send({}, { step: "send" });
        } catch (error) {
          caughtError(error);
        }
        went = true;
        return null;
      },
    });
    const { engine } = engineOf();
    const failing: WorkflowEngine = {
      ...engine,
      do: async (name, options, fn) =>
        name === "send:task"
          ? await Promise.reject(
              Object.assign(new Error("It may have been sent."), {
                name: "UncatchableFailure",
                code: "connect.outcome_unknown",
              })
            )
          : await engine.do(name, options, fn),
    };
    await expect(workflow.run(failing, {})).rejects.toMatchObject({
      code: "connect.outcome_unknown",
    });
    expect(went).toBeFalsy();
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
      mailed: { output: { id: "m-1" }, state: { last: "m-1", badge: {} } },
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
