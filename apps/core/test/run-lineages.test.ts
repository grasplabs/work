import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { runActorOf } from "@grasp-os/shared/audit";
import type { AuditActor, AuditEvent } from "@grasp-os/shared/audit";
import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import { quotaLimitsSchema } from "@grasp-os/shared/quota-policy";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { modelLedger } from "../src/model-ledger.ts";
import { models } from "../src/models.ts";
import type { ModelCall } from "../src/models.ts";
import { quotaPolicy } from "../src/workflows/quotas.ts";
import { runActor, startRun } from "../src/workflows/runs.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { finished, woken } from "./runs.ts";
import { openRpc, outcome, signedInApi, signedInWithRole } from "./sign-in.ts";
import {
  appWith as serverAppWith,
  bindModel,
  modelRegistration,
  workflowFiles,
} from "./workflow-apps.ts";

// A run lineage's model calls: a run and every run started under it count
// their model spend and provider requests together, against the lineage's
// root, for the lineage's whole life. AI Gateway is the outside system: a
// fake behind the AI binding. The runs, the engine, the dispatcher, the
// model ledger and the audit log are real. Child runs are started the way
// core starts a run under another (`startRun`'s `parent`): no App or run
// can name a parent or a root.

const idp = mockIdp();

const gateway = "grasp-os-test";
const workersAi = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** An answer that costs next to nothing. */
const cheapAnswer = { text: "Hi.", inputTokens: 10, outputTokens: 5 };

/**
 * An answer to the steps' schema that costs $0.293226 from Llama 3.3 (a
 * million tokens in at $0.293, 100 out at $2.253 a million): far more
 * than a step's request reserves, about $0.014 for Llama's default
 * 6,000-token answer, so what decides is what was spent.
 */
const dearTotal = {
  text: '{ "total": 1234 }',
  inputTokens: 1_000_000,
  outputTokens: 100,
};

/**
 * A new App with the sample server and `files`, its model resource
 * `reader`, which its runs' AI steps go through, bound to Llama 3.3.
 */
const appWith = async (
  builder: Parameters<typeof serverAppWith>[0],
  files: Record<string, string>
): Promise<string> => {
  const app = await serverAppWith(builder, {
    ...modelRegistration({ reader: 6000 }),
    ...files,
  });
  await bindModel(app, "reader", workersAi);
  return app;
};

/** A run's AI step, with `more` options. */
const llmStep = (more = "") => `  return await step.llm("extract", {
    description: "Read the total",
    binding: "reader",
    instructions: "Read the total in cents.",
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int() }),
    ${more}
  });`;

let monthsUsed = 0;

/** A month no other file counts budgets in. */
const newMonth = (): string => {
  monthsUsed += 1;
  return `${2500 + Math.floor(monthsUsed / 12)}-${String((monthsUsed % 12) + 1).padStart(2, "0")}`;
};

/**
 * What `run` returns, with `budgets` in the deployment's gateway config
 * and the fake gateway answering with `replies`: for the runs the
 * dispatcher runs and the calls the test makes alike.
 */
const withGateway = async <Result>(
  budgets: Record<string, unknown> | undefined,
  replies: GatewayReply[],
  run: (fake: ReturnType<typeof fakeGateway>) => Promise<Result>
): Promise<Result> => {
  const { MODEL_GATEWAY: before, MODEL_BUDGET_MONTH: month } = env;
  const fake = fakeGateway(...replies);
  const ai: AiBinding = env.AI;
  const sending = vi.spyOn(ai, "fetch").mockImplementation(fake.binding.fetch);
  try {
    env.MODEL_GATEWAY = {
      gateway,
      models: [workersAi],
      ...(budgets === undefined ? {} : { budgets }),
    };
    env.MODEL_BUDGET_MONTH = newMonth();
    return await run(fake);
  } finally {
    env.MODEL_GATEWAY = before;
    env.MODEL_BUDGET_MONTH = month;
    sending.mockRestore();
  }
};

/** The limits the tests' deployment sets (vite.config.ts). */
const configuredLimits = quotaLimitsSchema.parse(env.QUOTA_LIMITS).limits;

/**
 * The generation of the next quota policy a test sets: each higher than
 * any before, as an operator's must be.
 */
let generations = 100;

/**
 * Sets the operator's quota policy to `limits`, under a new generation,
 * which it returns.
 */
const setPolicy = (limits: Record<string, number>): number => {
  generations += 1;
  env.QUOTA_LIMITS = { generation: generations, limits };
  return generations;
};

/**
 * The quota policy generations the model ledger recorded the provider
 * requests of the lineage of `root` under, and how many under each.
 */
const generationsOf = async (root: string) =>
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
const setLedgerGeneration = async (generation?: number): Promise<void> => {
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
const onPolicyRead = (onRead: () => void): D1Database =>
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
const times = <Item>(count: number, item: Item): Item[] =>
  Array.from({ length: count }, () => item);

/** Someone signed in, with their API. */
type Builder = Awaited<ReturnType<typeof signedInApi>>;

/** Where `run` stands, as `builder` sees it. */
const statusOf = async (builder: Builder, run: string): Promise<string> => {
  const seen = await builder.api.workflows.status(run);
  return seen.status;
};

/** The audit events, the model ledger's delivered too. */
const eventsNow = async (): Promise<AuditEvent[]> => {
  await runDurableObjectAlarm(modelLedger(env));
  return await allEvents();
};

/** How `run` failed, as its `workflow.run.failed` event names it; none yet. */
const failedWith = async (run: string): Promise<unknown> => {
  const events = await allEvents();
  return events.find(
    ({ action, target }) =>
      action === "workflow.run.failed" && target?.id === run
  )?.detail.error;
};

/** The model gateway's refusals of `run`'s calls, as their reasons. */
const refusalsOf = async (run: string): Promise<unknown[]> => {
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
const startChild = async (
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
const startedByMail = async (
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
const rowsOf = async <Row>(query: string, ...binds: unknown[]) => {
  const { results } = await env.DB.prepare(query)
    .bind(...binds)
    .all<Row>();
  return results;
};

/** `id` by the name `names` gives it, or itself. */
const named = (
  id: string | null,
  names: Record<string, string>
): string | null =>
  Object.entries(names).find(([, value]) => value === id)?.[0] ?? id;

/** Whether core's database refused `query`, with `binds`, for an account. */
const refused = async (query: string, ...binds: unknown[]): Promise<string> =>
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
 * A call to Llama for the workflow run `trigger`, in the context of `app`
 * for `person`: capped at 100 tokens unless `capped` is false, when it
 * reserves as much as a step's (Llama's whole 24,000-token answer).
 */
const stepCall = (
  { app, person }: { app: string; person: string },
  trigger: AuditActor,
  capped = true
): ModelCall<undefined> => {
  const appId = appIdSchema.parse(app);
  return {
    model: workersAi,
    ...(capped ? { maxTokens: 100 } : {}),
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
const callFor = async (
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
const allAtOnce = async (
  triggers: readonly AuditActor[],
  work: Work
): Promise<string[]> =>
  await Promise.all(
    triggers.map(async (trigger) => await callUntilServed(work, trigger))
  );

/** How many of `outcomes` are `outcome`. */
const countOf = (outcomes: readonly string[], one: string): number =>
  outcomes.filter((each) => each === one).length;

describe("run lineages", { timeout: 90_000 }, () => {
  it("stop a run nested two deep once its lineage's spend reaches the run budget, after a restart too", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      ...workflowFiles("reader", llmStep(), { extract: { total: 1234 } }),
      // Waits a day first, so the test can restart it mid-wait.
      ...workflowFiles(
        "later",
        `  await step.sleep("pause", { description: "Wait", duration: "1 day" });
${llmStep()}`,
        { extract: { total: 1234 } }
      ),
    });

    // $0.50 a lineage: the root's and its child's answers spend $0.586.
    const result = await withGateway(
      { run: { limit: 0.5 } },
      times(3, dearTotal),
      async (fake) => {
        const root = await builder.api.workflows.start(app, "reader");
        await finished(root.id);
        const child = await startChild(app, "reader", root.id, builder.userId);
        await finished(child);
        const grandchild = await startChild(
          app,
          "later",
          child,
          builder.userId
        );
        // Stopped as it waits, and resumed: loaded anew, from its record.
        await woken(grandchild, "pause");
        await finished(grandchild);
        const events = await eventsNow();
        return {
          sent: fake.requests.length,
          root: await statusOf(builder, root.id),
          child: await statusOf(builder, child),
          grandchild: await failedWith(grandchild),
          refused: await refusalsOf(grandchild),
          // Its model events name the lineage's root, from its record.
          roots: events
            .filter(
              ({ action, actor }) =>
                action.startsWith("model.") &&
                actor.type === "workflow" &&
                actor.runId === grandchild
            )
            .map(({ actor }) =>
              actor.type === "workflow" && actor.rootRunId === root.id
                ? "root"
                : "other"
            ),
        };
      }
    );

    expect(result).toMatchObject({
      sent: 2,
      root: "completed",
      child: "completed",
      grandchild: "model.run_limit",
      refused: [["model.run_limit", "spend"]],
      roots: ["root"],
    });
  });

  it("hold back a lineage's run beside the others while their calls under way hold its run budget", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      ...workflowFiles("idle", "  return null;"),
      ...workflowFiles("reader", llmStep("retries: { limit: 0 },"), {
        extract: { total: 1234 },
      }),
    });
    const work = { app, person: builder.userId };
    const root = await builder.api.workflows.start(app, "idle");
    await finished(root.id);
    // Calls under way of the root and of a run beside the next, until
    // released: each reserves some $0.014 (Llama's default 6,000-token
    // answer), as a step does.
    const release = Promise.withResolvers<boolean>();
    const held = { ...cheapAnswer, pause: { at: 1, until: release.promise } };
    const branches = [
      runActorOf({ runId: root.id, app, workflow: "idle" }),
      runActorOf({
        runId: `run-${crypto.randomUUID()}`,
        app,
        workflow: "reader",
        rootRunId: root.id,
      }),
    ];

    // $0.03 a lineage fits two such calls at once, not a third beside
    // them: the child's step, which reserves some $0.007 (half its
    // binding's 6,000 tokens).
    const result = await withGateway(
      { run: { limit: 0.03 } },
      [...times(2, held), dearTotal],
      async (fake) => {
        const holding = Promise.all(
          branches.map(
            async (trigger) =>
              await outcome(models(env).call(stepCall(work, trigger, false)))
          )
        );
        await vi.waitFor(() => {
          expect(fake.requests).toHaveLength(2);
        });
        const child = await startChild(app, "reader", root.id, builder.userId);
        await finished(child);
        release.resolve(true);
        return {
          held: await holding,
          sent: fake.requests.length,
          child: await failedWith(child),
          refused: await refusalsOf(child),
        };
      }
    );

    expect(result).toStrictEqual({
      held: ["ok", "ok"],
      sent: 2,
      child: "model.budget_busy",
      refused: [["model.budget_busy", "run"]],
    });
  });

  it("charge a run another App's mail starts in a lineage to that App's account there: its spend, its time and its share, while its place counts in the lineage", async () => {
    const builder = await signedInApi(idp, "builder");
    const appX = await appWith(builder, {
      ...workflowFiles("idle", "  return null;"),
      ...workflowFiles("reader", llmStep("retries: { limit: 0 },"), {
        extract: { total: 1234 },
      }),
    });
    const appY = await appWith(
      builder,
      workflowFiles("reader", llmStep("retries: { limit: 0 },"), {
        extract: { total: 1234 },
      })
    );
    const root = await builder.api.workflows.start(appX, "idle");
    await finished(root.id);

    // $0.30 a lineage's account: one dear answer ($0.293) leaves no room
    // for a second step's request (some $0.014) beside it.
    const result = await withGateway(
      { run: { limit: 0.3 } },
      times(2, dearTotal),
      async (fake) => {
        const first = await startedByMail(appY, "reader", root.id);
        await finished(first);
        const second = await startedByMail(appY, "reader", root.id);
        await finished(second);
        // App X's own run under its root: App Y spent none of its budget.
        const own = await startChild(appX, "reader", root.id, builder.userId);
        await finished(own);
        const events = await eventsNow();
        // What admins see of the run budgets: App Y's account, apart from
        // the lineage's root.
        const { session } = await signedInWithRole(idp, "admin");
        const { core } = await openRpc(session, { coreEnv: env });
        const settings = await core.authenticate().models.settings();
        const budgets =
          settings.rules.state === "on" ? settings.rules.budgets : [];
        const listed = budgets
          .filter(({ scope }) => scope === "run")
          .flatMap(({ spent }) => spent)
          .flatMap(({ of }) =>
            of.type === "run" ? [[of.runId, of.rootRunId]] : []
          );
        const accounts = events
          .filter(
            ({ action, actor }) =>
              action.startsWith("model.") &&
              actor.type === "workflow" &&
              actor.appId === appY
          )
          .map(({ actor }) =>
            actor.type === "workflow" ? actor.accountRunId : undefined
          );
        return {
          sent: fake.requests.length,
          first: await statusOf(builder, first),
          second: await failedWith(second),
          own: await statusOf(builder, own),
          // Every model event of App Y's runs names its account: its first run.
          accounts: [...new Set(accounts)],
          firstId: first,
          // This lineage's: a lineage's spend outlives the month, so the
          // listing has other tests' too.
          listed: listed
            .filter(([id]) => id === first || id === root.id)
            .map((pair) =>
              pair.map((id) => named(id, { first, root: root.id }))
            )
            .toSorted(([one], [other]) =>
              String(one).localeCompare(String(other))
            ),
          // App Y's runs take App Y's triggers' share, not the root's
          // person's, and their attempts count on its account.
          attempts: await rowsOf<{ subject: string; account: string }>(
            "SELECT DISTINCT subject, root_run_id AS account FROM run_lineage_attempts WHERE run_id IN (?, ?)",
            first,
            second
          ),
          lineages: await rowsOf<{
            id: string;
            createdAt: number;
            descendants: number;
            used: number;
          }>(
            "SELECT root_run_id AS id, created_at AS createdAt, descendants, active_used_ms AS used FROM run_lineages WHERE root_run_id IN (?, ?)",
            root.id,
            first
          ),
        };
      }
    );
    const rootRow = result.lineages.find(({ id }) => id === root.id);
    const accountRow = result.lineages.find(({ id }) => id === result.firstId);

    expect({
      ...result,
      accounts: result.accounts.map((id) =>
        id === result.firstId ? "first" : id
      ),
      attempts: result.attempts.map(({ subject, account }) => [
        subject,
        account === result.firstId ? "first" : account,
      ]),
      lineages: {
        // All three runs took the lineage's places.
        descendants: rootRow?.descendants,
        // The account's age is the lineage's: no hop starts it afresh.
        sameAge: accountRow?.createdAt === rootRow?.createdAt,
        accountUsed: (accountRow?.used ?? 0) > 0,
        accountPlaces: accountRow?.descendants,
      },
      firstId: undefined,
    }).toStrictEqual({
      sent: 2,
      first: "completed",
      second: "model.run_limit",
      own: "completed",
      accounts: ["first"],
      firstId: undefined,
      // App Y's account names the lineage it is in; X's own run spent under
      // the root.
      listed: [
        ["first", "root"],
        ["root", null],
      ],
      attempts: [[`trigger:${appY}`, "first"]],
      lineages: {
        descendants: 3,
        sameAge: true,
        accountUsed: true,
        accountPlaces: 0,
      },
    });
  });

  it("charge an App's runs started in a lineage at once to one account", async () => {
    const builder = await signedInApi(idp, "builder");
    const appX = await appWith(
      builder,
      workflowFiles("idle", "  return null;")
    );
    const appY = await appWith(
      builder,
      workflowFiles("idle", "  return null;")
    );
    const root = await builder.api.workflows.start(appX, "idle");
    await finished(root.id);

    const started = await Promise.all(
      times(3, appY).map(
        async (app) => await startedByMail(app, "idle", root.id)
      )
    );
    // And App X's own run under the root is charged to the lineage's own.
    const own = await startedByMail(appX, "idle", root.id);
    await Promise.all(
      [...started, own].map(async (run) => {
        await finished(run);
      })
    );
    const accounts = await rowsOf<{ id: string; account: string | null }>(
      "SELECT id, account_run_id AS account FROM workflow_runs WHERE id IN (?, ?, ?, ?)",
      ...started,
      own
    );
    const ofY = new Set(
      accounts.filter(({ id }) => id !== own).map(({ account }) => account)
    );

    expect({
      ofY: ofY.size,
      oneOfThem: started.some((run) => ofY.has(run)),
      own: accounts.find(({ id }) => id === own)?.account,
    }).toStrictEqual({ ofY: 1, oneOfThem: true, own: null });
  });

  it("charge the root's App's runs another App's mail starts back in a lineage to an account of their own, so they can't use up the root's", async () => {
    const builder = await signedInApi(idp, "builder");
    const reader = workflowFiles("reader", llmStep("retries: { limit: 0 },"), {
      extract: { total: 1234 },
    });
    const appX = await appWith(builder, {
      ...workflowFiles("idle", "  return null;"),
      ...reader,
    });
    const appY = await appWith(
      builder,
      workflowFiles("idle", "  return null;")
    );
    const root = await builder.api.workflows.start(appX, "idle");
    await finished(root.id);
    const joined = await startedByMail(appY, "idle", root.id);
    await finished(joined);

    // $0.30 an account: one dear answer leaves no room for a second.
    const result = await withGateway(
      { run: { limit: 0.3 } },
      times(3, dearTotal),
      async (fake) => {
        // App Y's mail starts App X's runs again, under Y's run: they
        // spend an account of their own, one for all of them.
        const back = await startedByMail(appX, "reader", joined);
        await finished(back);
        const again = await startedByMail(appX, "reader", joined);
        await finished(again);
        // ...and one of theirs starts another under it: the same account.
        const under = await startedByMail(appX, "reader", back);
        await finished(under);
        // The root's own allowances are untouched: its next run spends.
        const own = await startChild(appX, "reader", root.id, builder.userId);
        await finished(own);
        const accounts = await rowsOf<{ id: string; account: string | null }>(
          "SELECT id, account_run_id AS account FROM workflow_runs WHERE id IN (?, ?, ?, ?)",
          back,
          again,
          under,
          own
        );
        const accountOf = (id: string) =>
          accounts.find((row) => row.id === id)?.account;
        return {
          sent: fake.requests.length,
          back: await statusOf(builder, back),
          again: await failedWith(again),
          under: await failedWith(under),
          own: await statusOf(builder, own),
          accounts: [accountOf(back), accountOf(again), accountOf(under)].map(
            (account) => (account === back ? "back" : account)
          ),
          ownAccount: accountOf(own),
        };
      }
    );

    expect(result).toStrictEqual({
      sent: 2,
      back: "completed",
      again: "model.run_limit",
      under: "model.run_limit",
      own: "completed",
      accounts: ["back", "back", "back"],
      ownAccount: null,
    });
  });

  it("keep a run's account, and an account's claim, as they were written", async () => {
    const builder = await signedInApi(idp, "builder");
    const appX = await appWith(
      builder,
      workflowFiles("idle", "  return null;")
    );
    const appY = await appWith(
      builder,
      workflowFiles("idle", "  return null;")
    );
    const root = await builder.api.workflows.start(appX, "idle");
    await finished(root.id);
    const joined = await startedByMail(appY, "idle", root.id);
    await finished(joined);

    expect({
      account: await refused(
        "UPDATE workflow_runs SET account_run_id = ? WHERE id = ?",
        root.id,
        joined
      ),
      cleared: await refused(
        "UPDATE workflow_runs SET account_run_id = NULL WHERE id = ?",
        joined
      ),
      claim: await refused(
        "UPDATE run_lineage_accounts SET account_run_id = ? WHERE root_run_id = ?",
        root.id,
        root.id
      ),
      deleted: await refused(
        "DELETE FROM run_lineage_accounts WHERE root_run_id = ?",
        root.id
      ),
      // A run with none may still be given one: as core starts it.
      unset: await refused(
        "UPDATE workflow_runs SET started_by = started_by WHERE id = ?",
        root.id
      ),
    }).toStrictEqual({
      account: "refused",
      cleared: "refused",
      claim: "refused",
      deleted: "refused",
      unset: "changed",
    });
  });

  it("tell a run another App started in a lineage nothing of when the lineage's calls under way were sent", async () => {
    const builder = await signedInApi(idp, "builder");
    const appX = await appWith(
      builder,
      workflowFiles("idle", "  return null;")
    );
    const appY = await appWith(
      builder,
      workflowFiles("idle", "  return null;")
    );
    const root = await builder.api.workflows.start(appX, "idle");
    await finished(root.id);
    const release = Promise.withResolvers<boolean>();
    const held = { ...cheapAnswer, pause: { at: 1, until: release.promise } };
    // A run of App Y in App X's lineage, as a run's own mail starts one
    // (connector-events.ts), and a run of App X beside it.
    const inLineage = (app: string) =>
      runActorOf({
        runId: `run-${crypto.randomUUID()}`,
        app,
        workflow: "idle",
        rootRunId: root.id,
      });
    const told = async (app: string) => {
      const refused = await models(env)
        .call(stepCall({ app, person: builder.userId }, inLineage(app), false))
        .then(
          () => "admitted",
          (error: unknown) => error
        );
      const { code, details } = z
        .object({
          code: z.string(),
          details: z.record(z.string(), z.unknown()),
        })
        .parse(refused);
      return [code, details.because, details.retryAfterSeconds];
    };

    // $0.02 a lineage fits one call reserving Llama's whole answer, not a
    // second beside it.
    const result = await withGateway(
      { run: { limit: 0.02 } },
      [held],
      async (fake) => {
        // The root's call may take 15 minutes: a wait derived from it
        // would be the most, five.
        const holding = outcome(
          models(env).call({
            ...stepCall(
              { app: appX, person: builder.userId },
              runActorOf({ runId: root.id, app: appX, workflow: "idle" }),
              false
            ),
            timeoutMs: 15 * 60_000,
          })
        );
        await vi.waitFor(() => {
          expect(fake.requests).toHaveLength(1);
        });
        const refusals = { appY: await told(appY), appX: await told(appX) };
        release.resolve(true);
        return { refusals, held: await holding };
      }
    );

    // A fixed wait, whichever App: a lineage may hold other Apps' calls.
    expect(result).toStrictEqual({
      refusals: {
        appY: ["model.budget_busy", "run", 60],
        appX: ["model.budget_busy", "run", 60],
      },
      held: "ok",
    });
  });

  it("count a retried step's requests on top of its lineage's, so its retry can't start the count afresh", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, {
      ...workflowFiles("idle", "  return null;"),
      ...workflowFiles("reader", llmStep("retries: { limit: 2, delay: 1 },"), {
        extract: { total: 1234 },
      }),
    });
    const work = { app, person: builder.userId };
    const root = await builder.api.workflows.start(app, "idle");
    await finished(root.id);
    const rootActor = runActorOf({ runId: root.id, app, workflow: "idle" });

    const result = await withGateway(
      undefined,
      [
        ...times(97, cheapAnswer),
        // Each of the step's attempts sends one request and two retries:
        // its first fails on server errors, and is tried again.
        ...times(3, { status: 500 }),
        ...times(6, dearTotal),
      ],
      async (fake) => {
        // The root used 97 of its lineage's 100 requests.
        const before = await allAtOnce(times(97, rootActor), work);
        const child = await startChild(app, "reader", root.id, builder.userId);
        await finished(child);
        return {
          before: countOf(before, "ok"),
          sentByChild: fake.requests.length - 97,
          child: await failedWith(child),
          refused: await refusalsOf(child),
        };
      }
    );

    expect(result).toStrictEqual({
      before: 97,
      sentByChild: 3,
      child: "model.run_limit",
      refused: [["model.run_limit", "requests"]],
    });
  });

  it("admit 100 provider requests a lineage, its root's and its children's together, however many ask at once, and no more", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({ name: "Lineages" });
    const work = { app, person: builder.userId };
    const root = `run-${crypto.randomUUID()}`;
    const rootActor = runActorOf({ runId: root, app, workflow: "reader" });
    const childActor = runActorOf({
      runId: `run-${crypto.randomUUID()}`,
      app,
      workflow: "reader",
      rootRunId: root,
    });
    const otherLineage = runActorOf({
      runId: `run-${crypto.randomUUID()}`,
      app,
      workflow: "reader",
    });

    const result = await withGateway(
      undefined,
      times(110, cheapAnswer),
      async (fake) => {
        const lineage = await allAtOnce(
          Array.from({ length: 101 }, (_, index) =>
            index % 2 === 0 ? rootActor : childActor
          ),
          work
        );
        return {
          ok: countOf(lineage, "ok"),
          refused: countOf(lineage, "model.run_limit"),
          // In the next month too: a lineage is counted for its whole life.
          again: await callFor(work, childActor, newMonth()),
          other: await callFor(work, otherLineage),
          sent: fake.requests.length,
        };
      }
    );

    expect(result).toStrictEqual({
      ok: 100,
      refused: 1,
      again: "model.run_limit",
      other: "ok",
      sent: 101,
    });
  });

  it("hold a lineage to the requests its operator's quota policy allows as each is sent, its runs already under way too, never above the platform's", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({ name: "Lowered" });
    const work = { app, person: builder.userId };
    const root = `run-${crypto.randomUUID()}`;
    const rootActor = runActorOf({ runId: root, app, workflow: "reader" });
    const childActor = runActorOf({
      runId: `run-${crypto.randomUUID()}`,
      app,
      workflow: "reader",
      rootRunId: root,
    });
    const otherLineage = runActorOf({
      runId: `run-${crypto.randomUUID()}`,
      app,
      workflow: "reader",
    });

    const result = await withGateway(
      undefined,
      times(20, cheapAnswer),
      async (fake) => {
        try {
          const { generation: first } = await quotaPolicy(env);
          const before = await allAtOnce(times(5, rootActor), work);
          // The operator lowers a lineage's requests to 8, while this one
          // is under way with 5 sent.
          const lowering = setPolicy({
            ...configuredLimits,
            lineageModelRequests: 8,
          });
          const lowered = await allAtOnce(times(5, childActor), work);
          const other = await callFor(work, otherLineage);
          // A policy raising it past the platform's is refused whole: the
          // lowered one stays in force.
          setPolicy({ ...configuredLimits, lineageModelRequests: 1000 });
          const raised = await callFor(work, childActor);
          // No longer lowered: the platform's 100 again, and the lineage
          // goes on from the 8 it sent.
          const restoring = setPolicy(configuredLimits);
          const restored = await callFor(work, rootActor);
          return {
            // Each request's receipt, under the policy it was admitted by.
            recorded: await generationsOf(root),
            expected: [
              { generation: first, requests: 5 },
              { generation: lowering, requests: 3 },
              { generation: restoring, requests: 1 },
            ],
            before: countOf(before, "ok"),
            lowered: {
              ok: countOf(lowered, "ok"),
              refused: countOf(lowered, "model.run_limit"),
            },
            other,
            raised,
            restored,
            sent: fake.requests.length,
          };
        } finally {
          setPolicy(configuredLimits);
        }
      }
    );

    const { recorded, expected, ...outcomes } = result;
    expect(outcomes).toStrictEqual({
      before: 5,
      lowered: { ok: 3, refused: 2 },
      other: "ok",
      raised: "model.run_limit",
      restored: "ok",
      sent: 10,
    });
    expect(recorded).toStrictEqual(expected);
  });

  it("hold a provider request's retry to a policy lowered while its call is under way", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({ name: "Retried" });
    const work = { app, person: builder.userId };
    const root = `run-${crypto.randomUUID()}`;
    const actor = runActorOf({ runId: root, app, workflow: "reader" });

    const result = await withGateway(
      undefined,
      [cheapAnswer, cheapAnswer, { status: 500 }, cheapAnswer],
      async (fake) => {
        const ai: AiBinding = env.AI;
        // The operator lowers a lineage's requests to the 3 this one has
        // sent, as its third goes out: the provider then fails it, and
        // the call tries again.
        vi.spyOn(ai, "fetch").mockImplementation(async (...args) => {
          if (fake.requests.length === 2) {
            setPolicy({ ...configuredLimits, lineageModelRequests: 3 });
          }
          return await fake.binding.fetch(...args);
        });
        try {
          const before = await allAtOnce(times(2, actor), work);
          const retried = await callFor(work, actor);
          return {
            before: countOf(before, "ok"),
            retried,
            sent: fake.requests.length,
          };
        } finally {
          setPolicy(configuredLimits);
        }
      }
    );

    expect(result).toStrictEqual({
      before: 2,
      retried: "model.run_limit",
      sent: 3,
    });
  });

  it("hold back a workflow's model call, sending nothing, when its quota policy can't be read or is behind the model ledger's", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({ name: "Behind" });
    const work = { app, person: builder.userId };
    const unreadableRun = `run-${crypto.randomUUID()}`;
    const behindRun = `run-${crypto.randomUUID()}`;
    const unreadable = runActorOf({
      runId: unreadableRun,
      app,
      workflow: "reader",
    });
    const behind = runActorOf({ runId: behindRun, app, workflow: "reader" });

    const result = await withGateway(undefined, [cheapAnswer], async (fake) => {
      const policyDown = await outcome(
        models({
          ...env,
          DB: onPolicyRead(() => {
            throw new Error("D1_ERROR: the database is unavailable");
          }),
        }).call(stepCall(work, unreadable))
      );
      // The ledger saw a generation core never recorded: core's database
      // restored from before it, say.
      const { generation } = await quotaPolicy(env);
      await setLedgerGeneration(generation + 1_000_000);
      try {
        const ledgerAhead = await callFor(work, behind);
        return {
          policyDown,
          ledgerAhead,
          refused: [
            ...(await refusalsOf(unreadableRun)),
            ...(await refusalsOf(behindRun)),
          ],
          sent: fake.requests.length,
        };
      } finally {
        await setLedgerGeneration();
      }
    });

    expect(result).toStrictEqual({
      policyDown: "model.quota_policy_unavailable",
      ledgerAhead: "model.quota_policy_behind",
      refused: [
        ["model.quota_policy_unavailable", null],
        ["model.quota_policy_behind", null],
      ],
      sent: 0,
    });
  });

  it("read the quota policy again, once, when the model ledger already admitted under a newer one", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({ name: "Raced" });
    const work = { app, person: builder.userId };
    const root = `run-${crypto.randomUUID()}`;
    const actor = runActorOf({ runId: root, app, workflow: "reader" });

    const result = await withGateway(undefined, [cheapAnswer], async (fake) => {
      // Another request already came to the ledger under the operator's
      // next policy, which this call's first read of the policy misses:
      // it is set only as that read reaches the database.
      const next = generations + 1;
      await setLedgerGeneration(next);
      const raced = { ...env };
      let changed = false;
      raced.DB = onPolicyRead(() => {
        if (!changed) {
          changed = true;
          raced.QUOTA_LIMITS = {
            generation: setPolicy(configuredLimits),
            limits: configuredLimits,
          };
        }
      });
      try {
        const call = await outcome(models(raced).call(stepCall(work, actor)));
        return {
          call,
          recorded: await generationsOf(root),
          next,
          sent: fake.requests.length,
        };
      } finally {
        await setLedgerGeneration();
      }
    });

    expect(result).toStrictEqual({
      call: "ok",
      recorded: [{ generation: result.next, requests: 1 }],
      next: result.next,
      sent: 1,
    });
  });

  it("count a run's calls against its own lineage, whatever lineage or root its input names", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(
      builder,
      workflowFiles("reader", llmStep(), { extract: { total: 1234 } })
    );
    const work = { app, person: builder.userId };
    const victim = runIdSchema.parse(`run-${crypto.randomUUID()}`);
    const victimActor = runActorOf({ runId: victim, app, workflow: "reader" });

    const result = await withGateway(
      undefined,
      [...times(100, cheapAnswer), dearTotal],
      async () => {
        // The victim's lineage used all of its requests.
        const used = await allAtOnce(times(100, victimActor), work);
        const forged = await builder.api.workflows.start(app, "reader", {
          rootRunId: victim,
          root: victim,
          parent: victim,
          lineage: victim,
          parentRunId: victim,
        });
        await finished(forged.id);
        const events = await eventsNow();
        return {
          used: countOf(used, "ok"),
          forged: await statusOf(builder, forged.id),
          // Its own root: no `rootRunId` at all.
          ownActor: runActorOf({ runId: forged.id, app, workflow: "reader" }),
          actor: events.find(
            ({ action, actor }) =>
              action === "model.call" &&
              actor.type === "workflow" &&
              actor.runId === forged.id
          )?.actor,
          victimAgain: await callFor(work, victimActor),
        };
      }
    );

    expect(result).toMatchObject({
      used: 100,
      forged: "completed",
      victimAgain: "model.run_limit",
    });
    expect(result.actor).toStrictEqual(result.ownActor);
  });
});
