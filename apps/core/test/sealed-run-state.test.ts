import { v } from "@grasp-os/sdk";
import { sealedTableSchema } from "@grasp-os/workflow-schema/sealed";
import type { SealedTask } from "@grasp-os/workflow-schema/sealed";
import { env } from "cloudflare:workers";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vite-plus/test";
import { z } from "zod";

import { resetWorkflowState, workflowStateOf } from "../src/workflow-state.ts";
import type { CallingRun } from "../src/workflows/resource-authority.ts";
import type { HostedSealedRun } from "../src/workflows/sealed-run.ts";
import { allEvents } from "./audit-events.ts";
import { endLiveResourceRuns } from "./json-workflow-apps.ts";
import { connectModels } from "./model-provider.ts";
import {
  allowedModel,
  moduleOf,
  ranAs,
  retryingEngine,
  sdkWorkflow,
  sealedRunOf,
  sealedWorkflow,
  send,
  waitingRun,
} from "./sealed-run-harness.ts";
import type { Sealed, Tries } from "./sealed-run-harness.ts";

// What a sealed run keeps between its workflow's runs (sealed-run.ts,
// workflow-state.ts), from its threat model: state the build didn't seal
// (a key more or less, a literal changed, a sensitive parameter, a record
// of another shape); a write by an attempt that failed, or a round its
// retry ran again; a write repeated when its step runs again or is
// replayed; a test run, or a restricted one, writing; a state too large;
// and a run's snapshot changing under it as other runs write. Each test
// runs a module of its own as the run's code, on the run host, against a
// real published build whose table the test gives state (`keeping`), as
// a build of a workflow that keeps state seals it.

/** What a task keeps, by key: its template and its value's shape. */
type Kept = NonNullable<SealedTask["state"]>;

/** The descriptor of `schema`, as a build seals it. */
const sealedShape = (schema: { descriptor: unknown }) =>
  z.json().parse(schema.descriptor);

/**
 * What `fetch` (a call that doesn't wait) keeps in the tests below: two
 * expressions' values and a literal, each of its own shape.
 */
const fetchKept: Kept = {
  count: { template: { slot: 0 }, value: sealedShape(v.number()) },
  seen: {
    template: { slot: 1 },
    value: sealedShape(v.union(v.string(), v.object({ who: v.string() }))),
  },
  kind: { template: { literal: "visit" }, value: sealedShape(v.string()) },
};

/** The run as loaded, its build's tasks keeping `keeps`, by task. */
const keeping =
  (keeps: Readonly<Record<string, Kept>>) =>
  (run: HostedSealedRun): HostedSealedRun => ({
    ...run,
    build: {
      ...run.build,
      tasks: run.build.tasks.map((task) =>
        Object.hasOwn(keeps, task.id)
          ? { ...task, state: keeps[task.id] }
          : task
      ),
    },
  });

const keepsFetch = keeping({ fetch: fetchKept });

/** Task `id`'s own step, recording `record`, with `options` besides. */
const taskStep = (id: string, record: string, options = ""): string =>
  `await step.do(${JSON.stringify(id)}, { key: "task", description: "Its task"${options} }, async () => (${record}))`;

/** `fetch`'s own step, keeping `state` beside its output. */
const keepFetch = (state: string): string =>
  `return ${taskStep("fetch", `{ output: { status: "done" }, state: ${state} }`)};`;

/** How many times run `runId`'s steps' state was written, and withheld. */
const stateEvents = async (runId: string) => {
  const events = await allEvents();
  const of = (action: string) =>
    events.filter(
      (event) => event.action === action && event.target?.id === runId
    ).length;
  return {
    written: of("workflow.state.written"),
    withheld: of("workflow.state.withheld"),
  };
};

/** A draft's test run, from what its start froze. */
const asDraft = (frozen: CallingRun): CallingRun => ({
  ...frozen,
  candidate: new Map(),
});

describe("a sealed run's state between runs on the run host", () => {
  let sealed: Sealed;

  beforeAll(async () => {
    await connectModels(`test-model-key-${crypto.randomUUID()}`, [
      allowedModel,
    ]);
    sealed = await sealedWorkflow();
  });

  beforeEach(async () => {
    await resetWorkflowState(env, sealed.by, sealed.workflow.id);
  });

  afterEach(endLiveResourceRuns);

  it("keeps what its step's sealed state names once it succeeded, once by its step's key, whatever a later run of the step sends", async () => {
    const runId = await waitingRun(sealed);
    const first = await ranAs(
      runId,
      moduleOf(keepFetch('{ count: 1, seen: input.who, kind: "visit" }')),
      { sealed: keepsFetch }
    );
    // Its activation lost before the engine journaled the step: the step
    // runs again, its code sending other values, and writes nothing.
    const again = await ranAs(
      runId,
      moduleOf(keepFetch('{ count: 2, seen: "Bob", kind: "visit" }')),
      { sealed: keepsFetch }
    );
    expect({
      first,
      again,
      state: await workflowStateOf(env, sealed.workflow.id),
      events: await stateEvents(runId),
    }).toStrictEqual({
      first: {
        ended: {
          output: { status: "done" },
          state: { count: 1, seen: "Ada", kind: "visit" },
        },
        tampered: [],
      },
      // Its step succeeded all the same: the first write stands.
      again: {
        ended: {
          output: { status: "done" },
          state: { count: 2, seen: "Bob", kind: "visit" },
        },
        tampered: [],
      },
      state: { count: 1, seen: "Ada", kind: "visit" },
      events: { written: 1, withheld: 0 },
    });
  });

  it("seals state only on a call that doesn't wait, never naming a sensitive parameter, at most 64 keys", async () => {
    const { build } = await sealedRunOf(await waitingRun(sealed));
    const table = {
      tasks: build.tasks,
      expressions: [],
      workflow: { output: true },
      params: [],
    };
    const tableOf = (id: string, kept: Kept): "sealed" | "refused" =>
      sealedTableSchema.safeParse({
        ...table,
        tasks: table.tasks.map((task) =>
          task.id === id ? { ...task, state: kept } : task
        ),
      }).success
        ? "sealed"
        : "refused";
    const keys = (count: number): Kept =>
      Object.fromEntries(
        Array.from({ length: count }, (_, at) => [
          `key${at}`,
          { template: { slot: at }, value: sealedShape(v.number()) },
        ])
      );
    expect({
      call: tableOf("fetch", fetchKept),
      // Each item of a loop, one after another, under its own step's key.
      callInLoop: tableOf("notify", fetchKept),
      model: tableOf("greet", fetchKept),
      raise: tableOf("stop", fetchKept),
      sleep: tableOf("linger", fetchKept),
      sleepUntil: tableOf("pause", fetchKept),
      tryTask: tableOf("guarded", fetchKept),
      loop: tableOf("rows", fetchKept),
      nestedParam: tableOf("fetch", {
        secret: {
          template: { object: [["inner", { array: [{ param: "token" }] }]] },
          value: sealedShape(v.object({ inner: v.array(v.string()) })),
        },
      }),
      sixtyFourKeys: tableOf("fetch", keys(64)),
      tooManyKeys: tableOf("fetch", keys(65)),
    }).toStrictEqual({
      call: "sealed",
      callInLoop: "sealed",
      model: "sealed",
      raise: "refused",
      sleep: "refused",
      sleepUntil: "refused",
      tryTask: "refused",
      loop: "refused",
      nestedParam: "refused",
      sixtyFourKeys: "sealed",
      tooManyKeys: "refused",
    });
  });

  it("keeps state beside whatever else its step records, which the run reads back as it was", async () => {
    const kept = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        `return ${taskStep("fetch", '{ output: { status: "done" }, context: { page: 2 }, state: { count: 1, seen: input.who, kind: "visit" } }')};`
      ),
      { sealed: keepsFetch }
    );
    expect({
      kept,
      state: await workflowStateOf(env, sealed.workflow.id),
    }).toStrictEqual({
      kept: {
        ended: {
          output: { status: "done" },
          context: { page: 2 },
          state: { count: 1, seen: "Ada", kind: "visit" },
        },
        tampered: [],
      },
      state: { count: 1, seen: "Ada", kind: "visit" },
    });
  });

  it("refuses state the build didn't seal, and keeps none of it", async () => {
    const refused = async (record: string, kept: Kept = fetchKept) => {
      const { ended, tampered } = await ranAs(
        await waitingRun(sealed),
        moduleOf(`return ${taskStep("fetch", record)};`),
        { sealed: keeping({ fetch: kept }) }
      );
      return { ended, tampered };
    };
    const asTampering = {
      ended: "workflow.invalid",
      tampered: ["workflow.invalid"],
    };
    expect({
      extraKey: await refused(
        '{ output: null, state: { count: 1, seen: "Ada", kind: "visit", more: 1 } }'
      ),
      missingKey: await refused(
        '{ output: null, state: { count: 1, seen: "Ada" } }'
      ),
      literalChanged: await refused(
        '{ output: null, state: { count: 1, seen: "Ada", kind: "other" } }'
      ),
      noState: await refused("{ output: null }"),
      wrongShape: await refused(
        '{ output: null, state: { count: "one", seen: "Ada", kind: "visit" } }'
      ),
      wrongNested: await refused(
        '{ output: null, state: { count: 1, seen: { who: 7 }, kind: "visit" } }'
      ),
      // A sensitive parameter's placeholder where an expression's value
      // goes: data, never filled in, and of the wrong shape here.
      sensitive: await refused(
        '{ output: null, state: { count: 1, seen: sensitiveParam("token"), kind: "visit" } }'
      ),
      state: await workflowStateOf(env, sealed.workflow.id),
    }).toStrictEqual({
      extraKey: asTampering,
      missingKey: asTampering,
      literalChanged: asTampering,
      noState: asTampering,
      wrongShape: asTampering,
      wrongNested: asTampering,
      sensitive: asTampering,
      state: {},
    });
  });

  it("writes nothing for a failed round: only the round that succeeded keeps its state", async () => {
    const runId = await waitingRun(sealed);
    const tries: Tries = new Map();
    // `guarded`'s catch retries `fetch`: its first two rounds fail, each
    // having made what it would keep.
    const retried = await ranAs(
      runId,
      moduleOf(`
let rounds = 0;
return ${taskStep("fetch", '(() => { rounds += 1; const record = { output: null, state: { count: rounds, seen: input.who, kind: "visit" } }; if (rounds < 3) throw new Error("not yet"); return record; })()', ', retry: async () => ({ by: "guarded", retry: true })')};`),
      { sealed: keepsFetch, engine: retryingEngine(tries) }
    );
    // A step that fails for good, its code going on past it: no write.
    const failed = await waitingRun(sealed);
    await ranAs(
      failed,
      moduleOf(`
try {
  ${taskStep("fetch", '(() => { throw new Error("never"); })()')};
} catch {}
return null;`),
      { sealed: keepsFetch, engine: retryingEngine() }
    );
    expect({
      retried: retried.ended,
      state: await workflowStateOf(env, sealed.workflow.id),
      events: await stateEvents(runId),
      failed: await stateEvents(failed),
    }).toStrictEqual({
      retried: {
        output: null,
        state: { count: 3, seen: "Ada", kind: "visit" },
      },
      state: { count: 3, seen: "Ada", kind: "visit" },
      events: { written: 1, withheld: 0 },
      failed: { written: 0, withheld: 0 },
    });
  });

  it("fails the step whose state is too large, a test run's too, after its call's effect for good, keeping none of it", async () => {
    const tooLarge = keepFetch(
      '{ count: 1, seen: "x".repeat(70000), kind: "visit" }'
    );
    const runId = await waitingRun(sealed);
    const big = await ranAs(runId, moduleOf(tooLarge), { sealed: keepsFetch });
    const draft = await ranAs(await waitingRun(sealed), moduleOf(tooLarge), {
      sealed: keepsFetch,
      calling: asDraft,
    });
    // Its mail sent first: no catch may take it as a call that didn't.
    const sent = await ranAs(
      await waitingRun(sealed),
      moduleOf(
        send(
          'await env.mail.call("mail.send", { to: input.who, subject: sensitiveParam("token") }); return { output: null, state: { big: "x".repeat(70000) } };'
        )
      ),
      {
        sealed: keeping({
          send: {
            big: { template: { slot: 0 }, value: sealedShape(v.string()) },
          },
        }),
      }
    );
    expect({
      big: { ended: big.ended, tampered: big.tampered },
      draft: { ended: draft.ended, tampered: draft.tampered },
      sent: { ended: sent.ended, tampered: sent.tampered },
      state: await workflowStateOf(env, sealed.workflow.id),
      events: await stateEvents(runId),
    }).toStrictEqual({
      big: { ended: "workflow.state_too_large", tampered: [] },
      draft: { ended: "workflow.state_too_large", tampered: [] },
      sent: { ended: "workflow.failed_after_effect", tampered: [] },
      state: {},
      events: { written: 0, withheld: 0 },
    });
  });

  it("counts a draft's snapshot in its step's state cap, and leaves a live run's total to its write", async () => {
    await ranAs(
      await waitingRun(sealed),
      moduleOf(
        keepFetch('{ count: 1, seen: "x".repeat(40000), kind: "visit" }')
      ),
      { sealed: keepsFetch }
    );
    const draftRun = await waitingRun(sealed);
    const liveRun = await waitingRun(sealed);
    // Emptied after both started: their snapshots still hold 40 KB.
    await resetWorkflowState(env, sealed.by, sealed.workflow.id);
    const extra = moduleOf(
      `return ${taskStep("fetch", '{ output: null, state: { extra: "y".repeat(30000) } }')};`
    );
    const keepsExtra = keeping({
      fetch: {
        extra: { template: { slot: 0 }, value: sealedShape(v.string()) },
      },
    });
    const draft = await ranAs(draftRun, extra, {
      sealed: keepsExtra,
      calling: asDraft,
    });
    const live = await ranAs(liveRun, extra, { sealed: keepsExtra });
    expect({
      draft: { ended: draft.ended, tampered: draft.tampered },
      live: live.tampered,
      kept: Object.keys(await workflowStateOf(env, sealed.workflow.id)),
    }).toStrictEqual({
      draft: { ended: "workflow.state_too_large", tampered: [] },
      live: [],
      kept: ["extra"],
    });
  });

  it("writes nothing for a draft's test run or a restricted run, which still checks its state; a restricted run's skip is audited", async () => {
    const as = async (calling: (frozen: CallingRun) => CallingRun) => {
      const runId = await waitingRun(sealed);
      const valid = await ranAs(
        runId,
        moduleOf(keepFetch('{ count: 1, seen: input.who, kind: "visit" }')),
        { sealed: keepsFetch, calling }
      );
      const tampered = await ranAs(
        await waitingRun(sealed),
        moduleOf(keepFetch('{ count: 1, seen: input.who, kind: "other" }')),
        { sealed: keepsFetch, calling }
      );
      return {
        ended: valid.tampered,
        tampered: tampered.tampered,
        events: await stateEvents(runId),
      };
    };
    expect({
      draft: await as(asDraft),
      restricted: await as((frozen) => ({ ...frozen, restricted: true })),
      state: await workflowStateOf(env, sealed.workflow.id),
    }).toStrictEqual({
      draft: {
        ended: [],
        tampered: ["workflow.invalid"],
        events: { written: 0, withheld: 0 },
      },
      restricted: {
        ended: [],
        tampered: ["workflow.invalid"],
        events: { written: 0, withheld: 1 },
      },
      state: {},
    });
  });

  it("goes on with an empty state for a run started before runs froze their state, whose receipt names no snapshot", async () => {
    await ranAs(
      await waitingRun(sealed),
      moduleOf(keepFetch('{ count: 1, seen: input.who, kind: "visit" }')),
      { sealed: keepsFetch }
    );
    const older = await waitingRun(sealed);
    // Its receipt as a core before this one wrote it: no snapshot named,
    // written around the trigger that keeps a receipt as it was.
    const guard = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'workflow_start_receipts_immutable_update'"
    ).first<{ sql: string }>();
    await env.DB.batch([
      env.DB.prepare("DROP TRIGGER workflow_start_receipts_immutable_update"),
      env.DB.prepare(
        "UPDATE workflow_start_receipts SET state_hash = NULL WHERE id = ?"
      ).bind(older),
      env.DB.prepare(guard?.sql ?? ""),
    ]);
    const resumed = await ranAs(
      older,
      `
import { workflow, z } from ${sdkWorkflow};
export default workflow("sealed", { params: {}, input: z.object({ who: z.string() }) }, async (step, { state }) => ({ state }));
`
    );
    expect(resumed).toStrictEqual({ ended: { state: {} }, tampered: [] });
  });

  it("hands every activation of a run the snapshot its start froze, frozen, whatever other runs write since", async () => {
    await ranAs(
      await waitingRun(sealed),
      moduleOf(
        keepFetch('{ count: 1, seen: { who: input.who }, kind: "visit" }')
      ),
      { sealed: keepsFetch }
    );
    const reader = await waitingRun(sealed);
    // Another run writes after the reader's start.
    await ranAs(
      await waitingRun(sealed),
      moduleOf(keepFetch('{ count: 3, seen: { who: "Bob" }, kind: "visit" }')),
      { sealed: keepsFetch }
    );
    const reads = `
import { workflow, z } from ${sdkWorkflow};
export default workflow("sealed", { params: {}, input: z.object({ who: z.string() }) }, async (step, { state }) => ({ state, frozen: Object.isFrozen(state) && Object.isFrozen(state.seen) }));
`;
    // Two activations, each loading the run afresh, as after a restart.
    const first = await ranAs(reader, reads);
    const second = await ranAs(reader, reads);
    const snapshot = {
      ended: {
        state: { count: 1, seen: { who: "Ada" }, kind: "visit" },
        frozen: true,
      },
      tampered: [],
    };
    expect({
      first,
      second,
      now: await workflowStateOf(env, sealed.workflow.id),
    }).toStrictEqual({
      first: snapshot,
      second: snapshot,
      now: { count: 3, seen: { who: "Bob" }, kind: "visit" },
    });
  });
});
