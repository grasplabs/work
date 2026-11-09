import type { Identity } from "@grasp-os/shared/rpc";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  approveWorkflowBinding,
  revokeWorkflowBinding,
} from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  workflowVersions,
} from "../src/workflow-resources.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { objectSchema } from "./json-workflow-apps.ts";
import { answeringProvider } from "./model-provider.ts";
import { withQuotas } from "./quota-limits.ts";
import { runObject } from "./runs.ts";
import { openRpc, refusal, signedInWithRole, unique } from "./sign-in.ts";
import {
  allowedModel,
  answer,
  chooseModel,
  definitionOf,
  ended,
  endOf,
  greetingWorkflow,
  hold,
  pause,
  person,
  providerAnswering,
  published,
  receiptsOf,
  started,
} from "./workflow-calls.ts";

// The calls of grasp-workflow/1 workflows on the run host (sealed-run.ts,
// resource-calls.ts and resource-authority.ts), from their threat model:
// a call reaches only the target its start froze; authority revoked while
// a run runs stops its next call; a replay repeats no effect; a sensitive
// parameter reaches connect as a connector argument and nothing the run
// records; and a run's model calls stay within its ceiling. Everything runs for
// real, through the dispatcher, the engine, connect and the App's own
// code; only the mail server and the model provider behind connect are
// faked.

const idp = mockIdp();

/** This month, as admins read spend in it, such as `2026-11`. */
const thisMonth = (): string =>
  new Date().toISOString().slice(0, "yyyy-mm".length);

/** What the models settings say an independent workflow spent this month. */
const workflowSpend = async (workflowId: string) => {
  const { session } = await signedInWithRole(idp, "admin");
  const { core } = await openRpc(session, {
    coreEnv: { ...env, SPEND_MONTH: thisMonth() },
  });
  const spend = await core.authenticate().models.spend();
  return spend.workflows.filter((each) => each.workflowId === workflowId);
};

/**
 * The module of action `greet`: `writer` asked twice (or `asks` times) for
 * a line of the declared shape, its answer the lines joined.
 */
const greetModule = (
  asks = 2
) => `import { action, resource, v } from "@grasp-os/sdk/action";

const writer = resource.model("writer", {
  output: v.object({ line: v.string() }),
});

export const greet = action({
  args: { who: v.string() },
  returns: v.object({ status: v.string() }),
  uses: [writer],
  handler: async (ctx, args) => {
    const lines: string[] = [];
    for (let ask = 0; ask < ${asks}; ask += 1) {
      const { line } = await ctx.resources.writer.generate({
        instructions: "Greet them.",
        input: { who: args.who, ask },
      });
      lines.push(line);
    }
    return { status: lines.join(" / ") };
  },
});
`;

/** The step calling action `greet` with the run's `who`. */
const greetTask = {
  id: "greet",
  type: "do",
  binding: "greet",
  arguments: { who: { $expr: "input.who" } },
};

/**
 * A workflow of `by`'s whose action `greet` asks `writer` (the allowed
 * model, approved by `admin`) for lines, running `steps`, ending with the
 * action's status. Its runs' model calls are held to `maxModelCalls`
 * (`quotas`, as `withQuotas` sets the run's ceiling).
 */
const writingWorkflow = async (
  by: Identity,
  admin: Identity,
  {
    steps,
    maxModelCalls,
    asks,
  }: { steps: unknown[]; maxModelCalls: number; asks?: number }
) => {
  const key = `writer-${unique()}`;
  await publishCatalogContract(env, admin, { key, kind: "model" });
  const { workflow, executable } = await published(by, {
    bindings: {
      greet: { kind: "action", contract: "local:code/greet.ts#greet" },
      writer: { kind: "model", contract: key },
    },
    steps,
    status: "steps.greet.output.status",
    modules: { "code/greet.ts": greetModule(asks) },
  });
  const approval = await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "writer",
    target: { kind: "model", model: allowedModel },
    reviewed: { version: 1 },
  });
  return {
    workflow,
    executable,
    approval,
    quotas: { lineageModelRequests: maxModelCalls },
  };
};

/** An agent step asking `writer` once more, as a step of the run's own. */
const writeAgain = {
  id: "again",
  type: "agent",
  binding: "writer",
  instructions: "Greet them again.",
  input: { who: { $expr: "input.who" } },
  output: objectSchema({ line: { kind: "string" } }),
};

describe("an independent workflow's model spend", () => {
  beforeAll(chooseModel);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts every run of it, as admins read it with its name and runs", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await greetingWorkflow(ada, admin);
    await providerAnswering(
      answer('{"line":"Hello Ada"}'),
      answer('{"line":"Hello again"}')
    );
    for (const _ of [1, 2]) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await ended(ada, workflow.id, await started(ada, workflow.id));
    }
    const read = await workflowSpend(workflow.id);
    const amount = read[0]?.amount ?? 0;
    expect(amount).toBeGreaterThan(0);
    expect(read).toStrictEqual([
      {
        appId: null,
        appName: null,
        workflowId: workflow.id,
        name: workflow.name,
        amount,
        runs: 2,
      },
    ]);
  });

  it("keeps a deleted workflow's spend for admins, by its ID, with no name to link it by", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await greetingWorkflow(ada, admin);
    await providerAnswering(answer('{"line":"Hello Ada"}'));
    await ended(ada, workflow.id, await started(ada, workflow.id));
    // Deleted since: its row stays, marked.
    await env.DB.prepare(
      "UPDATE workflow_resources SET deleted_at = ? WHERE id = ?"
    )
      .bind(Date.now(), workflow.id)
      .run();
    const read = await workflowSpend(workflow.id);
    expect(
      read.map(({ name, amount, runs }) => ({
        name,
        spent: amount > 0,
        runs,
      }))
    ).toStrictEqual([{ name: null, spent: true, runs: 1 }]);
  });
});

describe("model resources of a workflow's own actions", () => {
  beforeAll(chooseModel);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks the binding's model for the declared shape, each call an effect of its own", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, executable } = await writingWorkflow(ada, admin, {
      steps: [greetTask, pause],
      maxModelCalls: 2,
    });
    const provider = await providerAnswering(
      answer('{"line":"Hello Ada"}'),
      answer('{"line":"Hi again"}')
    );
    const runId = await started(ada, workflow.id);
    const run = await ended(ada, workflow.id, runId);
    const receipts = await receiptsOf(runId);
    const [version] = await workflowVersions(env, ada, workflow.id);
    expect({
      // The version's review shows the action's model use with the shape
      // its calls may answer, as sealed.
      listed: version?.actions.map(({ binding, uses }) => ({
        binding,
        uses: uses.map((use) => ({
          ...use,
          ...("output" in use
            ? {
                output: z
                  .record(z.string(), z.unknown())
                  .parse(JSON.parse(use.output)).kind,
              }
            : {}),
        })),
      })),
      executable,
      end: endOf(run),
      // Two requests, though the run replayed after its pause.
      requests: provider.requests.length,
      receipts: receipts.map(({ call, binding, outcome }) => ({
        call,
        binding,
        outcome,
      })),
    }).toStrictEqual({
      listed: [
        {
          binding: "greet",
          uses: [{ alias: "writer", kind: "model", output: "object" }],
        },
      ],
      executable: true,
      end: { status: "completed", output: { status: "Hello Ada / Hi again" } },
      requests: 2,
      receipts: ["started", "done", "started", "done"].map((outcome) => ({
        call: "grasp.model",
        binding: "writer",
        outcome,
      })),
    });
  });

  it("counts an action's model calls against the run's limit, within its attempt and across a replay", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    // The action spends the run's two calls; the step after its replay
    // asks for a third.
    const replayed = await writingWorkflow(ada, admin, {
      steps: [greetTask, pause, writeAgain],
      maxModelCalls: 2,
    });
    const replayProvider = await providerAnswering(
      answer('{"line":"Hello Ada"}'),
      answer('{"line":"Hi again"}'),
      answer('{"line":"Never sent"}')
    );
    const replayedEnd = await withQuotas(
      replayed.quotas,
      async () =>
        await ended(
          ada,
          replayed.workflow.id,
          await started(ada, replayed.workflow.id)
        )
    );
    const replayRequests = replayProvider.requests.length;
    vi.restoreAllMocks();
    // One call left for an action that asks twice: the second is never sent.
    const within = await writingWorkflow(ada, admin, {
      steps: [greetTask],
      maxModelCalls: 1,
    });
    const withinProvider = await providerAnswering(
      answer('{"line":"Hello Ada"}'),
      answer('{"line":"Never sent"}')
    );
    const { withinRun, withinEnd } = await withQuotas(
      within.quotas,
      async () => {
        const id = await started(ada, within.workflow.id);
        return {
          withinRun: id,
          withinEnd: await ended(ada, within.workflow.id, id),
        };
      }
    );
    // The call refused at the limit leaves its evidence, naming its binding.
    const events = await allEvents();
    const refusedAtLimit = events
      .filter(
        (event) =>
          event.action === "workflow.call.refused" &&
          event.target?.id === withinRun
      )
      .map(({ detail }) => ({
        call: detail?.call,
        reason: detail?.reason,
        errorCode: detail?.errorCode,
      }));
    expect({
      replayed: endOf(replayedEnd),
      replayRequests,
      within: endOf(withinEnd),
      withinRequests: withinProvider.requests.length,
      refusedAtLimit,
    }).toStrictEqual({
      replayed: { status: "failed", code: "workflow.model_call_limit" },
      replayRequests: 2,
      within: { status: "failed", code: "workflow.model_call_limit" },
      withinRequests: 1,
      refusedAtLimit: [
        {
          call: "writer",
          reason: "model_call_limit",
          errorCode: "workflow.model_call_limit",
        },
      ],
    });
  });

  it("takes the run's last model call against the count the run keeps, whichever activation made the others", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, quotas } = await writingWorkflow(ada, admin, {
      steps: [greetTask],
      maxModelCalls: 2,
    });
    const runIdOf = Promise.withResolvers<string>();
    // While the action's first request is out, another activation of the
    // run keeps a model call of its own: the action's second finds none
    // left.
    const provider = await answeringProvider(
      async (requests) => {
        if (requests.length === 1) {
          await runInDurableObject(
            runObject(await runIdOf.promise),
            (_object, state) => {
              state.storage.sql.exec(
                "INSERT INTO grasp_action_model_calls (key) VALUES ('elsewhere')"
              );
            }
          );
        }
        return answer('{"line":"Hello Ada"}');
      },
      { models: [allowedModel] }
    );
    const end = await withQuotas(quotas, async () => {
      const runId = await started(ada, workflow.id);
      runIdOf.resolve(runId);
      return await ended(ada, workflow.id, runId);
    });
    expect({
      end: endOf(end),
      requests: provider.requests.length,
    }).toStrictEqual({
      end: { status: "failed", code: "workflow.model_call_limit" },
      requests: 1,
    });
  });

  it("refuses a version whose actions' model output shapes are past what it may hold, pointing at the action", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const key = `writer-${unique()}`;
    await publishCatalogContract(env, admin, { key, kind: "model" });
    const workflow = await createWorkflowResource(env, ada, `big-${unique()}`);
    // One output shape of some 80 KB: within what a module's contract may
    // take, past what the version's manifest holds.
    const big = `import { action, resource, v } from "@grasp-os/sdk/action";

const values = Array.from({ length: 400 }, (_, index) => \`\${"x".repeat(190)}\${index}\`);
const writer = resource.model("writer", {
  output: v.object({ pick: v.enum(values as [string, ...string[]]) }),
});

export const greet = action({
  args: { who: v.string() },
  returns: v.object({ status: v.string() }),
  uses: [writer],
  handler: async () => ({ status: "never" }),
});
`;
    const error = await refusal(
      publishWorkflowVersion(env, ada, workflow.id, {
        definition: definitionOf({
          bindings: {
            greet: { kind: "action", contract: "local:code/greet.ts#greet" },
            writer: { kind: "model", contract: key },
          },
          steps: [greetTask],
        }),
        basedOn: null,
        modules: { "code/greet.ts": big },
      })
    );
    const parsed = z
      .object({
        code: z.string(),
        details: z.object({
          problems: z.array(
            z.looseObject({ code: z.string(), pointer: z.string() })
          ),
        }),
      })
      .parse(error);
    expect({
      code: parsed.code,
      problems: parsed.details.problems.map(({ code, pointer }) => ({
        code,
        pointer,
      })),
    }).toStrictEqual({
      code: "workflow.definition_invalid",
      problems: [
        {
          code: "manifest.too_large",
          pointer: "/bindings/greet",
        },
      ],
    });
  });

  it("fails on an answer outside the declared shape, and refuses the next call once its approval is revoked", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const shaped = await writingWorkflow(ada, admin, {
      steps: [greetTask],
      maxModelCalls: 2,
      asks: 1,
    });
    const shapedProvider = await providerAnswering(
      answer('{"other":"Hello Ada"}')
    );
    const shapedEnd = await ended(
      ada,
      shaped.workflow.id,
      await started(ada, shaped.workflow.id)
    );
    const shapedRequests = shapedProvider.requests.length;
    vi.restoreAllMocks();
    const revoked = await writingWorkflow(ada, admin, {
      steps: [hold, greetTask],
      maxModelCalls: 2,
      asks: 1,
    });
    const revokedProvider = await providerAnswering(
      answer('{"line":"Never sent"}')
    );
    const revokedRun = await started(ada, revoked.workflow.id);
    await revokeWorkflowBinding(
      env,
      admin,
      revoked.workflow.id,
      revoked.approval.id
    );
    const revokedEnd = await ended(ada, revoked.workflow.id, revokedRun);
    expect({
      shaped: endOf(shapedEnd),
      shapedRequests,
      revoked: endOf(revokedEnd),
      revokedRequests: revokedProvider.requests.length,
    }).toStrictEqual({
      // The gateway's refusal of an answer outside the declared shape.
      shaped: { status: "failed", code: "model.invalid_output" },
      shapedRequests: 1,
      revoked: { status: "failed", code: "workflow.call_denied" },
      revokedRequests: 0,
    });
  });
});
