import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { clientInternals, GraspClient } from "../src/client-core.ts";
import { GraspError } from "../src/client-error.ts";
import type { ClientTransport } from "../src/client-transport.ts";
import type { Id } from "../src/index.ts";
import type { WorkflowViewOf } from "../src/react.ts";
import { isPlainObject } from "../src/value-descriptor.ts";
import { applyingAtMostMs, WorkflowCalls } from "../src/workflow-calls.ts";
import { readWorkflowReference } from "../src/workflow-reference-read.ts";
import { workflowView } from "../src/workflow-view.ts";
import type { RunSnapshot } from "../src/workflow-view.ts";
import { workflows } from "./notes/server/_generated/api.ts";

// What `useWorkflow` shows and does (spec 10.4–10.4.7, 10.7.3), through
// the session client exactly as the hook drives it: its two live queries
// (`queries.run`, `queries.canStart`), read on render, and its starts and
// controls as calls of the reference's mutations (workflow-calls.ts),
// against the page the client reaches the host through. How a query is
// followed and a call recovered is the client's own (client.test.ts);
// core's side of these functions is its own test.

/** A call the host was sent, as the client wrote it. */
interface Call {
  readonly name: string;
  readonly kind: string;
  readonly input: unknown;
  readonly idempotencyKey: string;
}

/** What the host answers a call: a value, a refusal, or nothing at all. */
type Reply = { readonly value: unknown } | { readonly failed: string } | "lost";

/** A live query the client follows, and how the host pushes to it. */
interface Followed {
  readonly name: string;
  readonly input: unknown;
  released: boolean;
  readonly push: (value: unknown) => void;
}

const refusal = (code: string) => ({
  ok: false,
  error: {
    code,
    message: code,
    category: "contract",
    retryable: false,
    requestId: "r",
  },
});

/** The reference and input of a request's JSON text. */
const requestOf = (text: string) => {
  const parsed: unknown = JSON.parse(text);
  if (!isPlainObject(parsed) || !isPlainObject(parsed.reference)) {
    throw new Error("Not a call");
  }
  const { reference, input, idempotencyKey } = parsed;
  return {
    name: String(reference.name),
    kind: String(reference.kind),
    input,
    idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : "",
  };
};

const handleOf = (runId: string) => ({
  runId,
  workflowId: "wf_summarize",
  workflowVersion: 2,
  manifestHash: "m".repeat(64),
});

const path = (name: string): string => `workflows.summarizeNote.${name}`;

/** The page and host a client reaches, scripted by each test. */
const host = () => {
  const calls: Call[] = [];
  const followed: Followed[] = [];
  const responses: { run: string; decision: string; answer: unknown }[] = [];
  let reply: (call: Call) => Reply | Promise<Reply> = (call) =>
    call.name === path("mutations.start")
      ? { value: handleOf("run-1") }
      : { value: { kind: call.name.split(".").at(-1), state: "admitted" } };
  const transport: ClientTransport = {
    call: async (text) => {
      const call = requestOf(text);
      calls.push(call);
      const answer = await reply(call);
      if (answer === "lost") {
        throw new Error("The connection was reset.");
      }
      if ("failed" in answer) {
        return { result: refusal(answer.failed) };
      }
      return { result: { ok: true, value: answer.value } };
    },
    watch: async (text, onSnapshot) => {
      const { name, input } = requestOf(text);
      let revision = 0;
      const query: Followed = {
        name,
        input,
        released: false,
        push: (value) => {
          revision += 1;
          onSnapshot({ revision, result: { ok: true, value } });
        },
      };
      followed.push(query);
      await Promise.resolve();
      return {
        release: () => {
          query.released = true;
        },
      };
    },
    decisions: {
      respond: async (run, decision, answer) => {
        responses.push({ run, decision, answer });
        return await Promise.resolve({ status: "approved" });
      },
    },
  };
  /** The one open live query of `name` with `input`. */
  const one = (name: string, input: unknown): Followed => {
    const open = followed.filter(
      (query) =>
        !query.released &&
        query.name === path(name) &&
        JSON.stringify(query.input) === JSON.stringify(input)
    );
    const [found, ...more] = open;
    if (found === undefined || more.length > 0) {
      throw new Error(`Expected one live ${name}`);
    }
    return found;
  };
  return {
    client: new GraspClient(transport),
    calls,
    followed,
    responses,
    one,
    /** The live `run` query of `runId`. */
    run: (runId: string) => one("queries.run", { runId }),
    /** The live `canStart` query. */
    canStart: () => one("queries.canStart", {}),
    answer: (next: typeof reply) => {
      reply = next;
    },
    /** Holds every answer from now on: each call's, to give by hand. */
    holdAnswers: (): ((answer: Reply) => void)[] => {
      const held: ((answer: Reply) => void)[] = [];
      reply = async () => {
        const { promise, resolve } = Promise.withResolvers<Reply>();
        held.push(resolve);
        return await promise;
      };
      return held;
    },
  };
};

type Host = ReturnType<typeof host>;

/** A run of `summarizeNote` as its `run` query answers it, running. */
const snapshotOf = (overrides: Record<string, unknown> = {}) => ({
  ...handleOf("run-1"),
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

/** An event wait of `summarizeNote` as its `run` query names it. */
const listening = (event: Record<string, unknown> = {}) => ({
  kind: "event",
  id: "wait-1",
  taskId: "do/2/awaitEdit",
  key: "do/2/awaitEdit",
  title: "Waiting for an edit",
  openedAt: 1000,
  deadline: null,
  event: {
    kind: "workflowEvent",
    alias: "noteEdited",
    fingerprint: workflows.summarizeNote.events.noteEdited.fingerprint,
    ...event,
  },
  canSend: true,
});

// SAFETY: the form of the store's IDs; nothing here reads it further.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const noteId = "01890000-0000-7000-8000-000000000001" as Id<"notes">;

const unheard = (): void => {
  // A test reads the view when it asks.
};

/**
 * A hook showing `selection` of `summarizeNote` through `page`'s client,
 * as `useWorkflow` composes it: its calls, its live `run` query (while a
 * run is selected) and `canStart`, read and followed as `useQuery` does.
 */
const mount = (page: Host, initial?: string) => {
  let selection = initial;
  const internals = clientInternals(page.client);
  const read = readWorkflowReference(workflows.summarizeNote);
  const calls = new WorkflowCalls(page.client, read);
  calls.select(selection);
  const stops = new Map<string, () => void>();
  /** What `reference` with `args` shows now, followed from now on. */
  const follow = (reference: unknown, args: unknown) => {
    const entry = internals.entry(reference, args);
    if (!stops.has(entry.key)) {
      stops.set(entry.key, internals.subscribe(entry, unheard));
    }
    if (entry.snapshot.error !== undefined) {
      throw entry.snapshot.error;
    }
    return entry.snapshot.value;
  };
  const view = () => {
    const local = calls.local();
    const runId = selection ?? local.startedRunId;
    // SAFETY: what the `run` query's descriptor declares, which the host
    // checked its answer against.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const snapshot = (
      runId === undefined ? undefined : follow(read.functions.run, { runId })
    ) as RunSnapshot | null | undefined;
    const canStart = follow(read.functions.canStart, {});
    // SAFETY: as `useWorkflow` types it, by the reference it reads.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return workflowView({
      read,
      runId,
      snapshot,
      canStart: typeof canStart === "boolean" ? canStart : undefined,
      starting: local.starting > 0,
      submitting: local.submitting,
      commands: calls.commands,
    }) as WorkflowViewOf<typeof workflows.summarizeNote>;
  };
  return {
    calls,
    view,
    /** Selects run `runId` as the hook commits a new `{ runId }`. */
    select: (runId: string) => {
      selection = runId;
      calls.select(runId);
    },
    unmount: () => {
      for (const stop of stops.values()) {
        stop();
      }
      stops.clear();
    },
  };
};

/** Lets every answer and push under way arrive. */
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

/** The code of the structured error `promise` rejected with. */
const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GraspError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("It resolved");
};

/** A hook showing run-1, its `run` query answering `snapshot`. */
const showing = async (page: Host, snapshot: unknown = snapshotOf()) => {
  const hook = mount(page, "run-1");
  hook.view();
  await flush();
  page.run("run-1").push(snapshot);
  page.canStart().push(true);
  return hook;
};

describe("useWorkflow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("what a hook shows", () => {
    it("is idle and may start nothing until canStart says so, and calls nothing by itself", async () => {
      const page = host();
      const hook = mount(page);
      expect(hook.view()).toMatchObject({
        status: "idle",
        canStart: false,
        canPause: false,
        waits: [],
      });
      await flush();
      page.canStart().push(true);
      expect(hook.view()).toMatchObject({ status: "idle", canStart: true });
      expect(page.calls).toStrictEqual([]);
    });

    it("shows a run's status, its output once completed, and what the host says may be done with it", async () => {
      const page = host();
      const hook = await showing(page);
      expect(hook.view()).toMatchObject({
        status: "running",
        runId: "run-1",
        canPause: true,
        canResume: false,
        canCancel: true,
        pendingControl: null,
      });
      page.run("run-1").push(
        snapshotOf({
          status: "completed",
          finishedAt: 2000,
          output: { summary: "Short.", words: 1 },
          control: {
            canPause: true,
            canResume: true,
            canCancel: true,
            pendingControl: { kind: "pause", stage: "applying" },
          },
        })
      );
      // An ended run has nothing left to control, whatever the snapshot says.
      expect(hook.view()).toMatchObject({
        status: "completed",
        finishedAt: 2000,
        output: { summary: "Short.", words: 1 },
        canPause: false,
        canResume: false,
        canCancel: false,
        pendingControl: null,
      });
    });

    it("offers no control of a run that rolls back", async () => {
      const page = host();
      const hook = await showing(
        page,
        snapshotOf({
          status: "compensating",
          compensation: { cause: "cancellation", activity: "running" },
        })
      );
      expect(hook.view()).toMatchObject({
        status: "compensating",
        cause: "cancellation",
        canPause: false,
        canCancel: false,
      });
    });

    it("shows a run the person may not see as unavailable, never thrown, and shows it again once the host does", async () => {
      const page = host();
      const hook = await showing(page, null);
      expect(hook.view()).toMatchObject({
        status: "unavailable",
        runId: "run-1",
      });
      page.run("run-1").push(snapshotOf());
      expect(hook.view()).toMatchObject({ status: "running" });
    });

    it("shows an event wait with the event's own generated reference, and refuses a snapshot naming an event the reference doesn't hold", async () => {
      const page = host();
      const hook = await showing(page, snapshotOf({ waits: [listening()] }));
      const [wait] = hook.view().waits;
      expect(wait?.kind === "event" ? wait.event : undefined).toBe(
        workflows.summarizeNote.events.noteEdited
      );
      page
        .run("run-1")
        .push(
          snapshotOf({ waits: [listening({ alias: "documentUploaded" })] })
        );
      expect(() => hook.view()).toThrow(
        expect.objectContaining({ code: "contract.invalid_snapshot" })
      );
    });
  });

  describe("starting runs", () => {
    it("calls the reference's start mutation with the input under one key, and shows the run it admitted", async () => {
      const page = host();
      const hook = mount(page);
      hook.view();
      const started = hook.view().start({ noteId });
      expect(hook.view().isStarting).toBeTruthy();
      await expect(started).resolves.toStrictEqual(handleOf("run-1"));
      expect(page.calls).toMatchObject([
        {
          name: path("mutations.start"),
          kind: "mutation",
          input: { input: { noteId } },
        },
      ]);
      expect(hook.view()).toMatchObject({
        status: "loading",
        runId: "run-1",
        isStarting: false,
      });
      page.run("run-1").push(snapshotOf());
      expect(hook.view()).toMatchObject({ status: "running", runId: "run-1" });
    });

    it("selects the latest admitted start, never one admitted later but asked before", async () => {
      const page = host();
      const answers = page.holdAnswers();
      const hook = mount(page);
      const older = hook.view().start({ noteId });
      const newer = hook.view().start({ noteId });
      await flush();
      answers[1]?.({ value: handleOf("run-2") });
      await newer;
      answers[0]?.({ value: handleOf("run-1") });
      await expect(older).resolves.toMatchObject({ runId: "run-1" });
      expect(hook.view()).toMatchObject({ runId: "run-2", isStarting: false });
    });

    it("keeps the run shown when a start is refused, which rejects its own promise and is never the run's error", async () => {
      const page = host();
      const hook = await showing(page);
      page.answer(() => ({ failed: "workflow.start_denied" }));
      await expect(codeOf(hook.view().start({ noteId }))).resolves.toBe(
        "workflow.start_denied"
      );
      expect(hook.view()).toMatchObject({ status: "running", runId: "run-1" });
    });

    it("recovers a lost answer under the same key, never as a second start", async () => {
      const page = host();
      let lost = true;
      page.answer(() => {
        if (lost) {
          lost = false;
          return "lost";
        }
        return { value: handleOf("run-1") };
      });
      const hook = mount(page);
      const started = hook.view().start({ noteId });
      await vi.advanceTimersByTimeAsync(5000);
      await expect(started).resolves.toMatchObject({ runId: "run-1" });
      const [first, again] = page.calls;
      expect({
        calls: page.calls.length,
        sameKey: first?.idempotencyKey === again?.idempotencyKey,
      }).toStrictEqual({ calls: 2, sameKey: true });
    });

    it("never moves a run given by ID to the run it started", async () => {
      const page = host();
      const hook = await showing(page);
      page.answer(() => ({ value: handleOf("run-2") }));
      await hook.view().start({ noteId });
      expect(hook.view()).toMatchObject({ runId: "run-1" });
    });
  });

  describe("controlling the run shown", () => {
    it("refuses to control, send or answer while no run is selected, sending nothing", async () => {
      const page = host();
      const hook = mount(page);
      const { pause, send } = hook.view();
      expect({
        codes: [
          await codeOf(pause()),
          await codeOf(
            send(workflows.summarizeNote.events.styleChosen, { style: "long" })
          ),
        ],
        calls: page.calls,
      }).toStrictEqual({
        codes: ["workflow.not_attached", "workflow.not_attached"],
        calls: [],
      });
    });

    it("calls the control's mutation for the run, submitting until answered, applying until a newer snapshot shows where it stands", async () => {
      const page = host();
      const answers = page.holdAnswers();
      const hook = await showing(page);
      const paused = hook.view().pause();
      expect(hook.view()).toMatchObject({
        pendingControl: { kind: "pause", stage: "submitting" },
        canPause: false,
        canCancel: true,
      });
      await flush();
      answers[0]?.({ value: { kind: "pause", state: "admitted" } });
      await paused;
      expect(page.calls).toMatchObject([
        { name: path("mutations.pause"), input: { runId: "run-1" } },
      ]);
      // Admitted, before any snapshot read after it: never settled-looking.
      const admitted = hook.view();
      page.run("run-1").push(
        snapshotOf({
          status: "paused",
          control: {
            canPause: false,
            canResume: true,
            canCancel: true,
            pendingControl: null,
          },
        })
      );
      expect({
        admitted: {
          pendingControl: admitted.pendingControl,
          canPause: admitted.canPause,
        },
        settled: {
          status: hook.view().status,
          pendingControl: hook.view().pendingControl,
          canResume: hook.view().canResume,
        },
      }).toStrictEqual({
        admitted: {
          pendingControl: { kind: "pause", stage: "applying" },
          canPause: false,
        },
        settled: { status: "paused", pendingControl: null, canResume: true },
      });
    });

    it("leaves a control to the host's snapshot when the host applied it at once, or a snapshot of where it leads came first", async () => {
      const page = host();
      const hook = await showing(page);
      page.answer(() => ({ value: { kind: "pause", state: "applied" } }));
      await hook.view().pause();
      const applied = hook.view().pendingControl;
      // The paused run's snapshot overtakes the admission's answer, and
      // is the last the host pushes of it.
      const answers = page.holdAnswers();
      const paused = hook.view().pause();
      await flush();
      page.run("run-1").push(
        snapshotOf({
          status: "paused",
          control: {
            canPause: false,
            canResume: true,
            canCancel: true,
            pendingControl: null,
          },
        })
      );
      answers[0]?.({ value: { kind: "pause", state: "admitted" } });
      await paused;
      expect({
        applied,
        overtaken: {
          pendingControl: hook.view().pendingControl,
          canResume: hook.view().canResume,
        },
      }).toStrictEqual({
        applied: null,
        overtaken: { pendingControl: null, canResume: true },
      });
    });

    it("shows a cancel, this hook's or the host's, over a pause", async () => {
      const page = host();
      page.holdAnswers();
      const hook = await showing(page);
      void hook.view().pause();
      expect(hook.view().pendingControl).toStrictEqual({
        kind: "pause",
        stage: "submitting",
      });
      page.run("run-1").push(
        snapshotOf({
          control: {
            canPause: false,
            canResume: false,
            canCancel: false,
            pendingControl: { kind: "cancel", stage: "applying" },
          },
        })
      );
      expect(hook.view().pendingControl).toStrictEqual({
        kind: "cancel",
        stage: "applying",
      });
      void hook.view().cancel();
      expect(hook.view()).toMatchObject({
        pendingControl: { kind: "cancel", stage: "submitting" },
        canCancel: false,
      });
    });

    it("keeps its commands, each addressing the run selected when it is called, never the one a render saw", async () => {
      const page = host();
      const hook = mount(page);
      // Kept while idle, as a handler that starts a run and then cancels it.
      const { cancel, send } = hook.view();
      await hook.view().start({ noteId });
      await cancel();
      await send(workflows.summarizeNote.events.styleChosen, { style: "long" });
      // Kept while run-1 was selected, called once run-2 is.
      const watching = await showing(host(), snapshotOf());
      const { pause } = watching.view();
      const second = host();
      const other = mount(second, "run-1");
      other.view();
      await flush();
      second.run("run-1").push(snapshotOf());
      const kept = other.view().pause;
      other.select("run-2");
      other.view();
      await flush();
      second.run("run-2").push(snapshotOf(handleOf("run-2")));
      await kept();
      expect({
        same: pause === watching.view().pause,
        first: page.calls.map(({ name, input }) => ({ name, input })),
        second: second.calls.map(({ input }) => input),
      }).toStrictEqual({
        same: true,
        first: [
          { name: path("mutations.start"), input: { input: { noteId } } },
          { name: path("mutations.cancel"), input: { runId: "run-1" } },
          {
            name: path("mutations.send"),
            input: {
              runId: "run-1",
              event: "styleChosen",
              data: { style: "long" },
            },
          },
        ],
        second: [{ runId: "run-2" }],
      });
    });

    it("ends a control's applying within the most it waits when the host's last push came before its answer", async () => {
      const page = host();
      const hook = await showing(page);
      const answers = page.holdAnswers();
      const paused = hook.view().pause();
      await flush();
      // Another page resumed the run while this pause was under way: the
      // host ends where it began, and pushes nothing more.
      page.run("run-1").push(snapshotOf());
      answers[0]?.({ value: { kind: "pause", state: "admitted" } });
      await paused;
      const answered = hook.view().pendingControl;
      await vi.advanceTimersByTimeAsync(applyingAtMostMs);
      expect({
        answered,
        after: {
          pendingControl: hook.view().pendingControl,
          canPause: hook.view().canPause,
        },
      }).toStrictEqual({
        answered: { kind: "pause", stage: "applying" },
        after: { pendingControl: null, canPause: true },
      });
    });

    it("refuses a kept command once the hook lets go of its calls, sending nothing", async () => {
      const page = host();
      const hook = await showing(page);
      const { pause, send } = hook.view();
      // Another workflow or client, or unmounted.
      hook.calls.retire();
      expect({
        codes: [
          await codeOf(pause()),
          await codeOf(
            send(workflows.summarizeNote.events.styleChosen, { style: "long" })
          ),
        ],
        calls: page.calls,
      }).toStrictEqual({
        codes: ["workflow.not_attached", "workflow.not_attached"],
        calls: [],
      });
    });

    it("shows a control applying no longer than the most it waits, if the host never pushes again", async () => {
      const page = host();
      const hook = await showing(page);
      await hook.view().pause();
      const applying = hook.view().pendingControl;
      await vi.advanceTimersByTimeAsync(applyingAtMostMs);
      expect({ applying, after: hook.view().pendingControl }).toStrictEqual({
        applying: { kind: "pause", stage: "applying" },
        after: null,
      });
    });

    it("rejects a refused control without touching the run's view", async () => {
      const page = host();
      const hook = await showing(page);
      page.answer(() => ({ failed: "workflow.control_conflict" }));
      await expect(codeOf(hook.view().resume())).resolves.toBe(
        "workflow.control_conflict"
      );
      expect(hook.view()).toMatchObject({
        status: "running",
        pendingControl: null,
        canPause: true,
      });
    });

    it("stops following on unmount, pausing or cancelling nothing", async () => {
      const page = host();
      const hook = await showing(page);
      hook.unmount();
      await flush();
      expect({
        open: page.followed.filter((query) => !query.released).length,
        calls: page.calls.length,
      }).toStrictEqual({ open: 0, calls: 0 });
    });
  });

  describe("sending the run shown an event", () => {
    it("calls the send mutation with the event's alias and its data", async () => {
      const page = host();
      page.answer(() => ({ value: { eventId: "event-1" } }));
      const hook = await showing(page);
      await hook
        .view()
        .send(workflows.summarizeNote.events.styleChosen, { style: "short" });
      expect(page.calls).toMatchObject([
        {
          name: path("mutations.send"),
          input: {
            runId: "run-1",
            event: "styleChosen",
            data: { style: "short" },
          },
        },
      ]);
    });

    it("sends nothing for another workflow's event or one made up", async () => {
      const page = host();
      const hook = await showing(page);
      // Untyped, as a page that skips its types would send them.
      const send = async (event: unknown, data: unknown): Promise<void> => {
        await Reflect.apply(hook.view().send, undefined, [event, data]);
      };
      const codes = await Promise.all([
        codeOf(send(workflows.archiveNotes.events.confirmed, {})),
        codeOf(
          send(
            { ...workflows.summarizeNote.events.styleChosen, type: "made.up" },
            { style: "short" }
          )
        ),
        codeOf(send({ alias: "styleChosen" }, { style: "short" })),
      ]);
      expect({ codes, calls: page.calls }).toStrictEqual({
        codes: Array.from({ length: 3 }, () => "contract.invalid_request"),
        calls: [],
      });
    });
  });

  describe("answering a decision the run shown is held at", () => {
    it("asks the page to answer the exact wait, once, with the value its decision declares", async () => {
      const page = host();
      const wait = {
        kind: "decision",
        id: "decision-1",
        taskId: "review",
        key: "approveSummary",
        title: "Approve",
        openedAt: 1000,
        deadline: null,
        canRespond: true,
      };
      const hook = await showing(page, snapshotOf({ waits: [wait] }));
      const [shown] = hook.view().waits;
      if (shown?.kind !== "decision") {
        throw new Error("Expected the decision wait");
      }
      await hook.view().respond(shown, {
        approved: true,
        value: { comment: "Fine." },
      });
      await expect(
        codeOf(hook.view().respond(shown, { approved: true, value: "long" }))
      ).resolves.toBe("contract.invalid_args");
      expect({ responses: page.responses, calls: page.calls }).toStrictEqual({
        responses: [
          {
            run: "run-1",
            decision: "decision-1",
            answer: { approved: true, payload: { comment: "Fine." } },
          },
        ],
        calls: [],
      });
    });
  });
});
