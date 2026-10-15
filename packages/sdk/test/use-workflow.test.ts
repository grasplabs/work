import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { GraspClient } from "../src/client-core.ts";
import type { ClientTransport } from "../src/client-core.ts";
import { GraspError } from "../src/client-error.ts";
import {
  maxWaits,
  readWorkflowReference,
  workflowChannel,
} from "../src/client-workflow.ts";
import type { Id } from "../src/index.ts";
import { isPlainObject } from "../src/value-descriptor.ts";
import { WorkflowStore } from "../src/workflow-store.ts";
import type { Selection } from "../src/workflow-store.ts";
import { workflows } from "./workflow-refs.ts";

// What `useWorkflow` shows and does (spec 10.4–10.4.7, 10.7.2, 10.7.3),
// through the hook's store and the session client's workflow channel,
// exactly as the hook drives them (subscribe on commit, read the view on
// render, commands from handlers), against the page the client reaches
// the host through: core's answers to commands, its pushes of runs and
// bindings, refusals, and a connection that loses answers. Core's own
// side of the contract is its own test, once it serves it.

/** A command the host was sent, as the client wrote it. */
interface Command {
  readonly command: string;
  readonly runId: string | undefined;
  readonly idempotencyKey: string;
}

/** What the host answers a command: a value, a refusal, or nothing at all. */
type Reply =
  | { readonly value: unknown }
  | { readonly failed: string; readonly category?: string }
  | "lost";

/** A subscription the client made, and how the host speaks over it. */
interface Subscription {
  readonly runId: string | undefined;
  released: boolean;
  lost: boolean;
  readonly push: (revision: number, value: unknown) => void;
  readonly refuse: (revision: number, code: string, category: string) => void;
  readonly lose: () => void;
}

/** A field of the request `text` names, if it is a string. */
const fieldOf = (text: string, key: string): string | undefined => {
  const parsed: unknown = JSON.parse(text);
  const value = isPlainObject(parsed) ? parsed[key] : undefined;
  return typeof value === "string" ? value : undefined;
};

const refusal = (code: string, category: string) => ({
  ok: false,
  error: { code, message: code, category, retryable: false, requestId: "r" },
});

const handleOf = (runId: string) => ({
  runId,
  workflowId: "wf_summarize",
  workflowVersion: 2,
  manifestHash: "m".repeat(64),
});

/** What a test doesn't listen to. */
const unheard = (): void => {
  // Nothing to hear.
};

/** The page and host a client reaches, scripted by each test. */
const host = () => {
  const commands: Command[] = [];
  const subscriptions: Subscription[] = [];
  let reply: (command: Command) => Reply | Promise<Reply> = (command) =>
    command.command === "start"
      ? { value: handleOf("run-1") }
      : { value: { kind: command.command, state: "admitted" } };
  const transport: ClientTransport = {
    call: async (text) => {
      const command: Command = {
        command: fieldOf(text, "command") ?? "",
        runId: fieldOf(text, "runId"),
        idempotencyKey: fieldOf(text, "idempotencyKey") ?? "",
      };
      commands.push(command);
      const answer = await reply(command);
      if (answer === "lost") {
        throw new Error("The connection was reset.");
      }
      if ("failed" in answer) {
        return {
          result: refusal(answer.failed, answer.category ?? "contract"),
        };
      }
      return { result: { ok: true, value: answer.value } };
    },
    watch: async (text, onSnapshot, onLost) => {
      const subscription: Subscription = {
        runId: fieldOf(text, "runId"),
        released: false,
        lost: false,
        push: (revision, value) => {
          onSnapshot({ revision, result: { ok: true, value } });
        },
        refuse: (revision, code, category) => {
          onSnapshot({ revision, result: refusal(code, category) });
        },
        lose: () => {
          subscription.lost = true;
          onLost();
        },
      };
      subscriptions.push(subscription);
      await Promise.resolve();
      return {
        release: () => {
          subscription.released = true;
        },
      };
    },
  };
  /** The subscriptions still open to run `runId`, or to the binding. */
  const open = (runId?: string): Subscription[] =>
    subscriptions.filter(
      (subscription) =>
        !subscription.released &&
        !subscription.lost &&
        subscription.runId === runId
    );
  /** The one open subscription to run `runId`, or to the binding. */
  const one = (runId?: string): Subscription => {
    const [found, ...more] = open(runId);
    if (found === undefined || more.length > 0) {
      throw new Error(`Expected one subscription to ${runId ?? "the binding"}`);
    }
    return found;
  };
  return {
    client: new GraspClient(transport),
    commands,
    open,
    one,
    answer: (next: typeof reply) => {
      reply = next;
    },
  };
};

type Host = ReturnType<typeof host>;

/** A run of `summarizeNote` as the host projects it, running. */
const snapshotOf = (overrides: Record<string, unknown> = {}) => ({
  ...handleOf("run-1"),
  fingerprint: workflows.summarizeNote.fingerprint,
  status: "running",
  startedAt: 1000,
  finishedAt: null,
  waits: [],
  control: {
    canPause: true,
    canResume: false,
    canCancel: true,
    pendingControl: null,
  },
  ...overrides,
});

/** The control part of a snapshot. */
const controlOf = (
  can: { pause?: boolean; resume?: boolean; cancel?: boolean },
  pendingControl: { kind: string; stage: "applying" } | null = null
) => ({
  control: {
    canPause: can.pause ?? false,
    canResume: can.resume ?? false,
    canCancel: can.cancel ?? false,
    pendingControl,
  },
});

// SAFETY: the form of the store's IDs; nothing here reads it further.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const noteId = "01890000-0000-7000-8000-000000000001" as Id<"notes">;

/**
 * A hook showing `selection` of `summarizeNote` through `page`'s client,
 * mounted as React mounts it: how to read its view and render error, run
 * its commands, select another run (React's resubscription) and unmount.
 */
const mount = (page: Host, selection: Selection) => {
  const store = new WorkflowStore(
    workflowChannel(page.client),
    readWorkflowReference(workflows.summarizeNote)
  );
  let shown = selection;
  let stop = store.subscribe(shown, unheard);
  return {
    store,
    view: () => store.view(shown),
    error: () => store.error(shown),
    select: (next: Selection) => {
      stop();
      shown = next;
      stop = store.subscribe(shown, unheard);
    },
    unmount: () => {
      stop();
    },
  };
};

/** Lets every answer and push under way arrive. */
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

/** The structured error `promise` rejected with. */
const failureOf = async (promise: Promise<unknown>): Promise<GraspError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GraspError) {
      return error;
    }
    throw error;
  }
  throw new Error("It resolved");
};

/** The code of the structured error `promise` rejected with. */
const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  const error = await failureOf(promise);
  return error.code;
};

/** A hook showing run-1, its snapshot `snapshot` pushed at `revision`. */
const showing = async (page: Host, snapshot = snapshotOf(), revision = 1) => {
  const hook = mount(page, "run-1");
  await flush();
  page.one("run-1").push(revision, snapshot);
  return hook;
};

describe("what a hook shows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("permits nothing until the host says so, and starts or controls nothing by itself", async () => {
    const page = host();
    const hook = mount(page, null);
    await flush();
    expect(hook.view()).toMatchObject({
      status: "idle",
      canRun: false,
      canPause: false,
      canResume: false,
      canCancel: false,
      isStarting: false,
      pendingControl: null,
      waits: [],
    });
    page.one().push(1, { canRun: true });
    expect(hook.view().canRun).toBeTruthy();
    expect(page.commands).toStrictEqual([]);
  });

  it("follows a run once for every hook that shows it, each keeping its own selection", async () => {
    const page = host();
    const first = mount(page, "run-1");
    // React's Strict Mode subscribes, unsubscribes and subscribes again.
    first.select("run-1");
    const second = mount(page, "run-1");
    const third = mount(page, "run-2");
    await flush();
    expect([
      page.open("run-1").length,
      page.open("run-2").length,
      page.open().length,
    ]).toStrictEqual([1, 1, 1]);
    page.one("run-1").push(1, snapshotOf());
    expect([first.view().status, second.view().status]).toStrictEqual([
      "running",
      "running",
    ]);
    expect(third.view()).toMatchObject({ status: "loading", runId: "run-2" });
    expect(page.commands).toStrictEqual([]);
  });

  it("keeps a lost run on screen without permitting anything until a fresh push, and never sends a command to recover it", async () => {
    const page = host();
    const hook = await showing(page);
    expect(hook.view().canPause).toBeTruthy();
    page.one("run-1").lose();
    expect(hook.view()).toMatchObject({
      status: "running",
      canPause: false,
      canCancel: false,
    });
    await vi.advanceTimersByTimeAsync(31_000);
    page.one("run-1").push(1, snapshotOf());
    expect(hook.view()).toMatchObject({ canPause: true, canCancel: true });
    expect(page.commands).toStrictEqual([]);
  });

  it("shows no older revision after following again than it showed before", async () => {
    const page = host();
    const hook = await showing(page, snapshotOf({ status: "paused" }), 5);
    page.one("run-1").lose();
    await vi.advanceTimersByTimeAsync(31_000);
    page.one("run-1").push(4, snapshotOf({ status: "running" }));
    expect(hook.view()).toMatchObject({ status: "paused", canCancel: false });
    page.one("run-1").push(5, snapshotOf({ status: "paused" }));
    expect(hook.view()).toMatchObject({ status: "paused", canCancel: true });
  });

  it("shows no older revision over a newer one", async () => {
    const page = host();
    const hook = await showing(page, snapshotOf({ status: "paused" }), 5);
    page.one("run-1").push(4, snapshotOf({ status: "running" }));
    expect(hook.view().status).toBe("paused");
  });

  it("shows waits only with the snapshot they belong to, and an empty unconfirmed list before it", async () => {
    const page = host();
    const hook = mount(page, "run-1");
    await flush();
    expect(hook.view()).toMatchObject({ status: "loading", waits: [] });
    const decision = {
      kind: "decision",
      id: "wait-1",
      taskId: "review",
      key: "approveSummary",
      title: "Approve the summary",
      openedAt: 1000,
      deadline: 9000,
      canRespond: true,
    };
    const held = {
      kind: "blocked",
      id: "wait-2",
      taskId: "summarize",
      key: "$run",
      title: "Held for the quota",
      openedAt: 1000,
      deadline: null,
      reason: "quota",
      message: "The client's quota is used up for now.",
    };
    page
      .one("run-1")
      .push(1, snapshotOf({ status: "waiting", waits: [decision, held] }));
    const view = hook.view();
    expect(view).toMatchObject({ status: "waiting", waits: [decision, held] });
    expect(view.waits[1]).not.toHaveProperty("canRespond");
    expect(Object.isFrozen(view.waits)).toBeTruthy();
  });

  it("permits no control of a compensating run, whatever the host says, and shows no outcome before cleanup ends", async () => {
    const page = host();
    const hook = await showing(
      page,
      snapshotOf({
        status: "compensating",
        compensation: {
          cause: "failure",
          activity: "running",
          originalError: {
            code: "invoice.rejected",
            message: "The invoice was rejected.",
            category: "domain",
            retryable: false,
            requestId: null,
          },
        },
        ...controlOf({ pause: true, resume: true, cancel: true }),
      })
    );
    const view = hook.view();
    expect(view).toMatchObject({
      status: "compensating",
      cause: "failure",
      activity: "running",
      finishedAt: null,
      canPause: false,
      canResume: false,
      canCancel: false,
    });
    expect(view).not.toHaveProperty("output");
    expect(view).not.toHaveProperty("error");
  });

  it("shows a completed run's validated output, and permits no control of an ended run", async () => {
    const page = host();
    const hook = await showing(
      page,
      snapshotOf({
        status: "completed",
        finishedAt: 2000,
        output: { summary: "Short.", words: 1 },
      })
    );
    const view = hook.view();
    expect(view).toMatchObject({
      status: "completed",
      finishedAt: 2000,
      output: { summary: "Short.", words: 1 },
      canPause: false,
      canCancel: false,
    });
    expect(Object.isFrozen(view)).toBeTruthy();
  });
});

const sleeping = {
  kind: "timer",
  id: "wait-1",
  taskId: "pause",
  key: "pause",
  title: "Sleeping",
  openedAt: 1000,
  deadline: 5000,
  purpose: "sleep",
};

const malformed = Object.entries({
  "output that doesn't fit the contract": snapshotOf({
    status: "completed",
    finishedAt: 2000,
    output: { summary: 7, words: 1 },
  }),
  "a completed run without output": snapshotOf({
    status: "completed",
    finishedAt: 2000,
  }),
  "output before it completed": snapshotOf({
    output: { summary: "Early.", words: 1 },
  }),
  "a failed run without its error": snapshotOf({
    status: "failed",
    finishedAt: 2000,
  }),
  "an ended run without its end": snapshotOf({ status: "cancelled" }),
  "a compensation without its cause": snapshotOf({ status: "compensating" }),
  "a wait on an ended run": snapshotOf({
    status: "cancelled",
    finishedAt: 2000,
    waits: [sleeping],
  }),
  "a held run offered as answerable": snapshotOf({
    status: "waiting",
    waits: [
      {
        kind: "blocked",
        id: "wait-1",
        taskId: "summarize",
        key: "$run",
        title: "Held",
        openedAt: 1000,
        deadline: null,
        reason: "policy",
        message: "Held by policy.",
        canRespond: true,
      },
    ],
  }),
  "more waits than a snapshot holds": snapshotOf({
    status: "waiting",
    waits: Array.from({ length: maxWaits + 1 }, (_, index) => ({
      ...sleeping,
      id: `wait-${index}`,
    })),
  }),
  "a field the contract doesn't have": snapshotOf({ owner: "user-1" }),
  "another run's snapshot": snapshotOf({ runId: "run-9" }),
});

describe("what is never shown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(malformed)(
    "refuses %s before showing any of it",
    async (_what, snapshot) => {
      const page = host();
      const hook = await showing(page);
      page.one("run-1").push(2, snapshot);
      expect(hook.error()?.code).toBe("contract.invalid_snapshot");
      expect(hook.view()).toMatchObject({
        status: "loading",
        canPause: false,
        canCancel: false,
      });
    }
  );

  it("refuses a run that pins another contract than the reference", async () => {
    const page = host();
    const hook = await showing(
      page,
      snapshotOf({ fingerprint: "6".repeat(64) })
    );
    expect(hook.error()?.code).toBe("contract.mismatch");
    expect(hook.view().status).toBe("loading");
  });

  it.each([
    "summarizeNote",
    { ...workflows.summarizeNote, kind: "mutation" },
    { ...workflows.summarizeNote, visibility: "internal" },
    { ...workflows.summarizeNote, fingerprint: "not a hash" },
    { ...workflows.summarizeNote, output: { kind: "anything" } },
  ])("refuses %o as a workflow reference", (reference) => {
    expect(() => readWorkflowReference(reference)).toThrow(
      expect.objectContaining({ code: "contract.invalid_request" })
    );
  });

  it("refuses input the workflow doesn't take before sending anything", async () => {
    const page = host();
    const hook = mount(page, null);
    const code = await codeOf(hook.store.run({ noteId: "not an ID" }));
    expect(code).toBe("contract.invalid_args");
    expect(page.commands).toStrictEqual([]);
  });
});

describe("starting runs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("selects the latest admitted start and answers every caller its own handle", async () => {
    const page = host();
    const answers = [
      Promise.withResolvers<Reply>(),
      Promise.withResolvers<Reply>(),
    ];
    const [first, second] = answers;
    page.answer(async () => await (answers.shift()?.promise ?? "lost"));
    const hook = mount(page, null);
    const older = hook.store.run({ noteId });
    const newer = hook.store.run({ noteId });
    await flush();
    expect(hook.view()).toMatchObject({ status: "idle", isStarting: true });
    second?.resolve({ value: handleOf("run-2") });
    await expect(newer).resolves.toStrictEqual(handleOf("run-2"));
    first?.resolve({ value: handleOf("run-1") });
    await expect(older).resolves.toStrictEqual(handleOf("run-1"));
    expect(hook.view()).toMatchObject({
      status: "loading",
      runId: "run-2",
      isStarting: false,
    });
    // Two deliberate starts are two submissions, never one deduplicated.
    const keys = new Set(page.commands.map((sent) => sent.idempotencyKey));
    expect(keys.size).toBe(2);
  });

  it("keeps the run shown when a start is refused, and never shows the refusal as the run's error", async () => {
    const page = host();
    const hook = mount(page, null);
    await hook.store.run({ noteId });
    await flush();
    page.one("run-1").push(1, snapshotOf());
    page.answer(() => ({
      failed: "workflow.start_denied",
      category: "authorization",
    }));
    const code = await codeOf(hook.store.run({ noteId }));
    expect(code).toBe("workflow.start_denied");
    expect(hook.view()).toMatchObject({ status: "running", runId: "run-1" });
    expect(hook.view()).not.toHaveProperty("error");
  });

  it("never moves an explicit selection to the run it started", async () => {
    const page = host();
    page.answer(() => ({ value: handleOf("run-8") }));
    const hook = mount(page, "run-7");
    await hook.store.run({ noteId });
    expect(hook.view()).toMatchObject({ status: "loading", runId: "run-7" });
  });

  it("refuses an admission answer that isn't a run's handle, with its key to recover it", async () => {
    const page = host();
    page.answer(() => ({ value: { runId: 7 } }));
    const hook = mount(page, null);
    const refused = await failureOf(hook.store.run({ noteId }));
    expect(refused).toMatchObject({
      code: "contract.invalid_receipt",
      details: { idempotencyKey: page.commands[0]?.idempotencyKey },
    });
    expect(hook.view()).toMatchObject({ status: "idle", isStarting: false });
  });

  it("recovers a lost admission answer under the same key, never as a second start", async () => {
    const page = host();
    let attempts = 0;
    page.answer(() => {
      attempts += 1;
      return attempts === 1 ? "lost" : { value: handleOf("run-1") };
    });
    const hook = mount(page, null);
    const started = hook.store.run({ noteId });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(started).resolves.toStrictEqual(handleOf("run-1"));
    const [sent, again] = page.commands;
    expect(page.commands).toHaveLength(2);
    expect(again?.idempotencyKey).toBe(sent?.idempotencyKey);
  });
});

describe("selecting another run", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears the old run's view and shows none of its late pushes", async () => {
    const page = host();
    const hook = await showing(page);
    const old = page.one("run-1");
    hook.select("run-2");
    expect(hook.view()).toMatchObject({ status: "loading", runId: "run-2" });
    old.push(2, snapshotOf({ status: "paused" }));
    await flush();
    expect(hook.view()).toMatchObject({ status: "loading", runId: "run-2" });
    expect(old.released).toBeTruthy();
  });

  it("never lets a control asked of the old run show on the new one", async () => {
    const page = host();
    const answered = Promise.withResolvers<Reply>();
    page.answer(async () => await answered.promise);
    const hook = await showing(page);
    const paused = hook.store.pause();
    expect(hook.view().pendingControl).toStrictEqual({
      kind: "pause",
      stage: "submitting",
    });
    hook.select("run-2");
    await flush();
    page.one("run-2").push(1, snapshotOf(handleOf("run-2")));
    answered.resolve({ value: { kind: "pause", state: "admitted" } });
    await paused;
    expect(page.commands).toStrictEqual([
      expect.objectContaining({ command: "pause", runId: "run-1" }),
    ]);
    expect(hook.view()).toMatchObject({
      runId: "run-2",
      pendingControl: null,
      canPause: true,
    });
  });

  it("shows nothing of a control asked before the selection moved away and back", async () => {
    const page = host();
    const answered = Promise.withResolvers<Reply>();
    page.answer(async () => await answered.promise);
    const hook = await showing(page);
    const paused = hook.store.pause();
    hook.select("run-2");
    hook.select("run-1");
    expect(hook.view().pendingControl).toBeNull();
    answered.resolve({ value: { kind: "pause", state: "admitted" } });
    await paused;
    expect(hook.view().pendingControl).toBeNull();
  });
});

describe("controlling the selected run", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses to control a run that isn't shown yet", async () => {
    const page = host();
    const idle = mount(page, null);
    const loading = mount(page, "run-1");
    const codes = [
      await codeOf(idle.store.cancel()),
      await codeOf(loading.store.pause()),
    ];
    expect(codes).toStrictEqual([
      "workflow.not_attached",
      "workflow.not_attached",
    ]);
    expect(page.commands).toStrictEqual([]);
  });

  it("resolves once admitted, recovering a lost answer under the same key", async () => {
    const page = host();
    let attempts = 0;
    page.answer(() => {
      attempts += 1;
      return attempts === 1
        ? "lost"
        : { value: { kind: "pause", state: "admitted" } };
    });
    const hook = await showing(page);
    const paused = hook.store.pause();
    await flush();
    expect(hook.view().pendingControl).toStrictEqual({
      kind: "pause",
      stage: "recovering",
    });
    await vi.advanceTimersByTimeAsync(1000);
    await paused;
    const [sent, again] = page.commands;
    expect(again?.idempotencyKey).toBe(sent?.idempotencyKey);
    expect(hook.view().pendingControl).toStrictEqual({
      kind: "pause",
      stage: "applying",
    });
  });

  it("rejects a refused control without touching the run's view", async () => {
    const page = host();
    page.answer(() => ({ failed: "workflow.control_conflict" }));
    const hook = await showing(page);
    const code = await codeOf(hook.store.resume());
    expect(code).toBe("workflow.control_conflict");
    expect(hook.view()).toMatchObject({
      status: "running",
      pendingControl: null,
      canPause: true,
    });
    expect(hook.view()).not.toHaveProperty("error");
  });

  it("keeps an admitted control applying until a newer snapshot settles it", async () => {
    const page = host();
    const hook = await showing(page, snapshotOf(), 3);
    await hook.store.pause();
    expect(hook.view()).toMatchObject({
      pendingControl: { kind: "pause", stage: "applying" },
      canPause: false,
      canCancel: true,
    });
    page
      .one("run-1")
      .push(
        4,
        snapshotOf(
          controlOf({ cancel: true }, { kind: "pause", stage: "applying" })
        )
      );
    expect(hook.view().pendingControl).toStrictEqual({
      kind: "pause",
      stage: "applying",
    });
    page.one("run-1").push(
      5,
      snapshotOf({
        status: "paused",
        ...controlOf({ resume: true, cancel: true }),
      })
    );
    expect(hook.view()).toMatchObject({
      status: "paused",
      pendingControl: null,
      canResume: true,
    });
  });

  it("joins an identical control still unanswered", async () => {
    const page = host();
    const answered = Promise.withResolvers<Reply>();
    page.answer(async () => await answered.promise);
    const hook = await showing(page);
    const first = hook.store.cancel();
    const second = hook.store.cancel();
    answered.resolve({ value: { kind: "cancel", state: "admitted" } });
    await Promise.all([first, second]);
    expect(page.commands).toHaveLength(1);
  });

  it("lets cancel overtake a stalled pause, whose late answer never brings the pause back", async () => {
    const page = host();
    const pauseAnswer = Promise.withResolvers<Reply>();
    page.answer(async (command) =>
      command.command === "pause"
        ? await pauseAnswer.promise
        : { value: { kind: "cancel", state: "admitted" } }
    );
    const hook = await showing(page);
    const paused = hook.store.pause();
    await hook.store.cancel();
    expect(page.commands.map(({ command }) => command)).toStrictEqual([
      "pause",
      "cancel",
    ]);
    expect(hook.view()).toMatchObject({
      pendingControl: { kind: "cancel", stage: "applying" },
      canCancel: false,
    });
    pauseAnswer.resolve({ value: { kind: "pause", state: "admitted" } });
    await paused;
    expect(hook.view().pendingControl).toStrictEqual({
      kind: "cancel",
      stage: "applying",
    });
    page
      .one("run-1")
      .push(
        2,
        snapshotOf({ status: "cancelled", finishedAt: 3000, ...controlOf({}) })
      );
    expect(hook.view()).toMatchObject({
      status: "cancelled",
      pendingControl: null,
      canPause: false,
      canResume: false,
      canCancel: false,
    });
  });

  it("keeps showing an unanswered cancel over a pause asked for after it", async () => {
    const page = host();
    const cancelAnswer = Promise.withResolvers<Reply>();
    page.answer(async (command) =>
      command.command === "cancel"
        ? await cancelAnswer.promise
        : { failed: "workflow.control_conflict" }
    );
    const hook = await showing(page);
    const cancelled = hook.store.cancel();
    const paused = hook.store.pause();
    expect(hook.view().pendingControl).toStrictEqual({
      kind: "cancel",
      stage: "submitting",
    });
    const code = await codeOf(paused);
    expect(code).toBe("workflow.control_conflict");
    cancelAnswer.resolve({ value: { kind: "cancel", state: "admitted" } });
    await cancelled;
  });

  it("shows another screen's admitted cancel over this hook's own pause", async () => {
    const page = host();
    const pauseAnswer = Promise.withResolvers<Reply>();
    page.answer(async () => await pauseAnswer.promise);
    const hook = await showing(page);
    const paused = hook.store.pause();
    page
      .one("run-1")
      .push(
        2,
        snapshotOf(controlOf({}, { kind: "cancel", stage: "applying" }))
      );
    expect(hook.view()).toMatchObject({
      pendingControl: { kind: "cancel", stage: "applying" },
      canCancel: false,
    });
    pauseAnswer.resolve({ failed: "workflow.control_conflict" });
    const code = await codeOf(paused);
    expect(code).toBe("workflow.control_conflict");
  });
});

describe("losing access", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["screen.revoked", "binding"],
    ["auth.session_expired", "run"],
  ] as const)(
    "clears every run and permits nothing once %s arrives on a %s",
    async (code, on) => {
      const page = host();
      const hook = await showing(page);
      const other = mount(page, null);
      await flush();
      page.one().push(1, { canRun: true });
      expect(hook.view()).toMatchObject({ canRun: true, canPause: true });
      page
        .one(on === "binding" ? undefined : "run-1")
        .refuse(2, code, "authorization");
      expect([hook.error()?.code, other.error()?.code]).toStrictEqual([
        code,
        code,
      ]);
      expect(hook.view()).toMatchObject({
        status: "loading",
        canRun: false,
        canPause: false,
        canCancel: false,
      });
      const refused = await codeOf(hook.store.pause());
      expect(refused).toBe("workflow.not_attached");
      expect({
        open: page.open("run-1"),
        commands: page.commands,
      }).toStrictEqual({ open: [], commands: [] });
    }
  );

  it("stops following on unmount, without pausing or cancelling the run", async () => {
    const page = host();
    const hook = await showing(page);
    hook.unmount();
    await flush();
    expect({
      run: page.open("run-1"),
      binding: page.open(),
      commands: page.commands,
    }).toStrictEqual({ run: [], binding: [], commands: [] });
  });

  it("follows no run on a host that can't push them", async () => {
    const portable = new GraspClient({
      url: "https://grasp.example.com",
      getToken: async () => await Promise.resolve(null),
    });
    const store = new WorkflowStore(
      workflowChannel(portable),
      readWorkflowReference(workflows.summarizeNote)
    );
    store.subscribe("run-1", unheard);
    await flush();
    expect(store.error("run-1")?.code).toBe("workflow.unavailable");
  });
});
