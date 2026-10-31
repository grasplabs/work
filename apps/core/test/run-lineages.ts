import type { AuditActor, AuditEvent } from "@grasp-os/shared/audit";
import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import { quotaLimitsSchema } from "@grasp-os/shared/quota-policy";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import { modelLedger } from "../src/model-ledger.ts";
import { models } from "../src/models.ts";
import type { ModelCall } from "../src/models.ts";
import { runActor, startRun } from "../src/workflows/runs.ts";
import { allEvents } from "./audit-events.ts";
import { answeringProvider, fakeProviderFor } from "./model-provider.ts";
import type {
  FakeProvider,
  ProviderReply,
  SentRequest,
} from "./model-provider.ts";
import type { signedInApi } from "./sign-in.ts";
import { outcome } from "./sign-in.ts";
import {
  appCall,
  appWith as serverAppWith,
  bindModel,
  modelRegistration,
  workflowFiles,
} from "./workflow-apps.ts";

// A run lineage's model calls: a run and every run started under it count
// their model spend and provider requests together, against the lineage's
// root, for the lineage's whole life. The model provider behind connect
// is the outside system (test/model-provider.ts). The runs, the engine,
// the dispatcher, the model ledger and the audit log are real. Child runs are started the way
// core starts a run under another (`startRun`'s `parent`): no App or run
// can name a parent or a root.
//
// What run-lineage-spend, -requests and -policies.test.ts share: each
// calls `mockIdp()` itself, since a module is loaded once for many files.

/** The model the runs' AI steps go through: Mistral Large, which doesn't think. */
export const lineageModel = "mistral/mistral-large-latest";

/** The answer a step's binding allows, in tokens. */
const stepAnswerTokens = 6000;

/** An answer that costs next to nothing. */
export const cheapAnswer = { text: "Hi.", inputTokens: 10, outputTokens: 5 };

/**
 * An answer to the steps' schema that costs $0.50015 from Mistral Large (a
 * million tokens in at $0.50, 100 out at $1.50 a million): far more than
 * a step's request reserves, about $0.01 for its binding's 6,000-token
 * answer, so what decides is what was spent.
 */
export const dearTotal = {
  text: '{ "total": 1234 }',
  inputTokens: 1_000_000,
  outputTokens: 100,
};

/**
 * A new App with the sample server and `files`, its model resource
 * `reader`, which its runs' AI steps go through, bound to Mistral Large:
 * a model the organization chose, as an admin binds only those, with a
 * provider that answers nothing until a test connects its own
 * (`withProvider`).
 */
export const appWith = async (
  builder: Parameters<typeof serverAppWith>[0],
  files: Record<string, string>
): Promise<string> => {
  const app = await serverAppWith(builder, {
    ...modelRegistration({ reader: stepAnswerTokens }),
    ...files,
  });
  await fakeProviderFor([lineageModel]);
  await bindModel(app, "reader", lineageModel);
  return app;
};

/** A run's AI step, with `more` options. */
export const llmStep = (more = "") => `  return await step.llm("extract", {
    description: "Read the total",
    binding: "reader",
    instructions: "Read the total in cents.",
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int() }),
    ${more}
  });`;

/**
 * The sample App with an action, `assist.draft`, that asks its model
 * resource `reader`, and a workflow, `drafter`, whose step calls it: a
 * run's model request made through one of its App's functions.
 */
export const draftingFiles = (): Record<string, string> => {
  const sample = modelRegistration({});
  return {
    ...sample,
    "app.ts": (sample["app.ts"] ?? "")
      .replace(
        'import schema from "./schema.ts";',
        'import { draft, reader } from "./operations/assist.ts";\nimport schema from "./schema.ts";'
      )
      .replace("  operations: {", "  operations: {\n    assist: { draft },")
      .replace(
        "uses: [stats, send, search",
        "uses: [stats, send, search, reader"
      ),
    "operations/assist.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const reader = resource.model("reader", { maxOutputTokens: 6000 });

export const draft = action({
  args: { prompt: v.string() },
  returns: v.string(),
  uses: [reader],
  handler: async (ctx, args) => await ctx.resources.reader.generate({ prompt: args.prompt }),
});
`,
    ...workflowFiles(
      "drafter",
      `  return await step.do("draft", { description: "Draft it" }, async () => ${appCall("assist.draft", "action", '{ prompt: "Hi" }', "string")});`,
      { draft: "Hi." }
    ),
  };
};

let monthsUsed = 0;

/** A month no other file counts budgets in. */
export const newMonth = (): string => {
  monthsUsed += 1;
  return `${2500 + Math.floor(monthsUsed / 12)}-${String((monthsUsed % 12) + 1).padStart(2, "0")}`;
};

/**
 * What `run` returns, with `budgets` in the deployment's model rules and
 * the provider answering with `replies`, in order, or with what `respond`
 * makes of the requests so far: for the runs the dispatcher runs and the
 * calls the test makes alike.
 */
export const withProvider = async <Result>(
  budgets: Record<string, unknown> | undefined,
  replies:
    | ProviderReply[]
    | ((requests: readonly SentRequest[]) => ProviderReply | undefined),
  run: (fake: FakeProvider) => Promise<Result>
): Promise<Result> => {
  const { MODEL_GATEWAY: before, MODEL_BUDGET_MONTH: month } = env;
  const fake = Array.isArray(replies)
    ? await fakeProviderFor([lineageModel], ...replies)
    : await answeringProvider(replies, { models: [lineageModel] });
  try {
    env.MODEL_GATEWAY = budgets === undefined ? {} : { budgets };
    env.MODEL_BUDGET_MONTH = newMonth();
    return await run(fake);
  } finally {
    env.MODEL_GATEWAY = before;
    env.MODEL_BUDGET_MONTH = month;
  }
};

/** The limits the tests' deployment sets (vite.config.ts). */
export const configuredLimits = quotaLimitsSchema.parse(
  env.QUOTA_LIMITS
).limits;

/**
 * The generation of the next quota policy a test sets: each higher than
 * any before, as an operator's must be.
 */
let generations = 100;

/** The generation the latest quota policy was set under. */
export const policyGeneration = (): number => generations;

/**
 * Sets the operator's quota policy to `limits`, under a new generation,
 * which it returns.
 */
export const setPolicy = (limits: Record<string, number>): number => {
  generations += 1;
  env.QUOTA_LIMITS = { generation: generations, limits };
  return generations;
};

/**
 * The quota policy generations the model ledger recorded the provider
 * requests of the lineage of `root` under, and how many under each.
 */
export const generationsOf = async (root: string) =>
  await runInDurableObject(modelLedger(env), (_instance, state) =>
    state.storage.sql
      .exec<{ generation: number | null; requests: number }>(
        "SELECT policy_generation AS generation, count(*) AS requests FROM requests WHERE actor LIKE ? GROUP BY policy_generation ORDER BY policy_generation",
        `%${root}%`
      )
      .toArray()
  );

/**
 * Sets the model ledger's highest quota policy generation to
 * `generation`, as a ledger ahead of core would have it; none clears it.
 */
export const setLedgerGeneration = async (
  generation?: number
): Promise<void> => {
  await runInDurableObject(modelLedger(env), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM policy");
    if (generation !== undefined) {
      state.storage.sql.exec(
        "INSERT INTO policy (id, generation) VALUES (0, ?)",
        generation
      );
    }
  });
};

/**
 * Core's database, with `onRead` run as each statement on the quota
 * policy's table is prepared: one that throws is a table that can't be
 * read.
 */
export const onPolicyRead = (onRead: () => void): D1Database =>
  new Proxy(env.DB, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (property === "prepare") {
        return (query: string): unknown => {
          if (query.includes("quota_policies")) {
            onRead();
          }
          return target.prepare(query);
        };
      }
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });

/** `count` of `item`. */
export const times = <Item>(count: number, item: Item): Item[] =>
  Array.from({ length: count }, () => item);

/** Someone signed in, with their API. */
type Builder = Awaited<ReturnType<typeof signedInApi>>;

/** Where `run` stands, as `builder` sees it. */
export const statusOf = async (
  builder: Builder,
  run: string
): Promise<string> => {
  const seen = await builder.api.workflows.status(run);
  return seen.status;
};

/** The audit events, the model ledger's delivered too. */
export const eventsNow = async (): Promise<AuditEvent[]> => {
  await runDurableObjectAlarm(modelLedger(env));
  return await allEvents();
};

/** How `run` failed, as its `workflow.run.failed` event names it; none yet. */
export const failedWith = async (run: string): Promise<unknown> => {
  const events = await allEvents();
  return events.find(
    ({ action, target }) =>
      action === "workflow.run.failed" && target?.id === run
  )?.detail.error;
};

/** The model gateway's refusals of `run`'s calls, as their reasons. */
export const refusalsOf = async (run: string): Promise<unknown[]> => {
  const events = await eventsNow();
  return events
    .filter(
      ({ action, actor }) =>
        action === "model.refused" &&
        actor.type === "workflow" &&
        actor.runId === run
    )
    .map(({ detail }) => [detail.reason, detail.because]);
};

/** Starts a run of `workflow` under `parent`, as core starts a child run. */
export const startChild = async (
  app: string,
  workflow: string,
  parent: string,
  startedBy: string
): Promise<string> => {
  const parentRun = runIdSchema.parse(parent);
  const run = await startRun(env, {
    app: appIdSchema.parse(app),
    workflow: workflowIdSchema.parse(workflow),
    input: null,
    startedBy,
    actor: runActor({ id: parentRun, appId: app, workflowId: workflow }),
    parent: parentRun,
  });
  return run.id;
};

/**
 * Starts a run of `workflow` of `app` under `parent` that nobody started,
 * as a run's own mail to a mailbox `app` watches starts one
 * (connector-events.ts): `app` may be another App than the parent's.
 */
export const startedByMail = async (
  app: string,
  workflow: string,
  parent: string
): Promise<string> => {
  const run = await startRun(env, {
    app: appIdSchema.parse(app),
    workflow: workflowIdSchema.parse(workflow),
    input: null,
    startedBy: null,
    actor: { type: "system" },
    parent: runIdSchema.parse(parent),
  });
  return run.id;
};

/** What core's database holds of `query`'s rows, with `binds`. */
export const rowsOf = async <Row>(query: string, ...binds: unknown[]) => {
  const { results } = await env.DB.prepare(query)
    .bind(...binds)
    .all<Row>();
  return results;
};

/** `id` by the name `names` gives it, or itself. */
export const named = (
  id: string | null,
  names: Record<string, string>
): string | null =>
  Object.entries(names).find(([, value]) => value === id)?.[0] ?? id;

/** Whether core's database refused `query`, with `binds`, for an account. */
export const refused = async (
  query: string,
  ...binds: unknown[]
): Promise<string> =>
  await env.DB.prepare(query)
    .bind(...binds)
    .run()
    .then(
      () => "changed",
      (error: unknown) =>
        error instanceof Error && error.message.includes("account")
          ? "refused"
          : String(error)
    );

/**
 * A call to Mistral Large for the workflow run `trigger`, in the context
 * of `app` for `person`: capped at 100 tokens unless `capped` is false,
 * when it reserves as much as a step's (its binding's 6,000-token answer,
 * some $0.01).
 */
export const stepCall = (
  { app, person }: { app: string; person: string },
  trigger: AuditActor,
  capped = true
): ModelCall<undefined> => {
  const appId = appIdSchema.parse(app);
  return {
    model: lineageModel,
    maxTokens: capped ? 100 : stepAnswerTokens,
    input: "Hello.",
    purpose: "workflow.step",
    trigger,
    work: {
      authority: {
        subject: { type: "app", appId },
        onBehalfOf: person,
        mode: "interactive",
        appVersion: 1,
      },
      context: { type: "app", appId },
    },
  };
};

/** Where the calls a test makes itself work: an App, for its builder. */
interface Work {
  app: string;
  person: string;
}

/** The outcome of one call for `trigger`, counted in `month` if given. */
export const callFor = async (
  work: Work,
  trigger: AuditActor,
  month?: string
): Promise<string> => {
  const before = env.MODEL_BUDGET_MONTH;
  env.MODEL_BUDGET_MONTH = month ?? before;
  try {
    return await outcome(models(env).call(stepCall(work, trigger)));
  } finally {
    env.MODEL_BUDGET_MONTH = before;
  }
};

/**
 * The outcome of a call for `trigger`, asked again each time it is told
 * it is queued for a share of the model requests in flight, as a caller
 * would: more at once than the shares and the queue's places hold are
 * told so at once (model-admission.ts), and nothing else of them counts.
 */
const callUntilServed = async (
  work: Work,
  trigger: AuditActor
): Promise<string> => {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- asked again once told it is queued
    const told = await callFor(work, trigger);
    if (told !== "model.queued") {
      return told;
    }
    // oxlint-disable-next-line no-await-in-loop -- a moment before asking again
    await scheduler.wait(50);
  }
};

/** The outcomes of calls for each of `triggers`, made all at once. */
export const allAtOnce = async (
  triggers: readonly AuditActor[],
  work: Work
): Promise<string[]> =>
  await Promise.all(
    triggers.map(async (trigger) => await callUntilServed(work, trigger))
  );

/**
 * The outcomes of calls for each of `triggers`, one after another: a
 * lineage's requests used up before what a test is about. All at once,
 * a person's share of requests in flight (four) admits them four a round,
 * each round five seconds on, as the provider behind connect answers in
 * its own time: a hundred took longer than a test may.
 */
export const inTurn = async (
  triggers: readonly AuditActor[],
  work: Work
): Promise<string[]> => {
  const outcomes: string[] = [];
  for (const trigger of triggers) {
    // oxlint-disable-next-line no-await-in-loop -- one call after another
    outcomes.push(await callFor(work, trigger));
  }
  return outcomes;
};

/** How many of `outcomes` are `outcome`. */
export const countOf = (outcomes: readonly string[], one: string): number =>
  outcomes.filter((each) => each === one).length;
