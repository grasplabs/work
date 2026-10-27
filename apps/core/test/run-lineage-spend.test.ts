import { runActorOf } from "@grasp-os/shared/audit";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { budgetMonth } from "../src/model-budgets.ts";
import { modelLedger } from "../src/model-ledger.ts";
import { models } from "../src/models.ts";
import { mockIdp } from "./idp.ts";
import {
  appWith,
  cheapAnswer,
  dearTotal,
  draftingFiles,
  eventsNow,
  failedWith,
  llmStep,
  named,
  refusalsOf,
  refused,
  rowsOf,
  startChild,
  startedByMail,
  statusOf,
  stepCall,
  times,
  withGateway,
  workersAi,
} from "./run-lineages.ts";
import { finished, woken } from "./runs.ts";
import { openRpc, outcome, signedInApi, signedInWithRole } from "./sign-in.ts";
import {
  appWith as serverAppWith,
  bindModel,
  workflowFiles,
} from "./workflow-apps.ts";

// A run lineage's model spend: its runs, and the runs other Apps start
// in it, held to the run budget, each App's on an account of its own.
// The helpers it shares with the other run lineage files: run-lineages.ts.

const idp = mockIdp();

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

  it("charge the model requests a run in another App's account makes through its App's functions to that account", async () => {
    const builder = await signedInApi(idp, "builder");
    const appX = await appWith(
      builder,
      workflowFiles("idle", "  return null;")
    );
    const appY = await serverAppWith(builder, draftingFiles());
    await bindModel(appY, "reader", workersAi);
    const root = await builder.api.workflows.start(appX, "idle");
    await finished(root.id);

    const result = await withGateway(
      { run: { limit: 1 } },
      [cheapAnswer],
      async (fake) => {
        const joined = await startedByMail(appY, "drafter", root.id);
        await finished(joined);
        const events = await eventsNow();
        const calls = events.filter(
          ({ action, actor }) =>
            action === "model.call" &&
            actor.type === "workflow" &&
            actor.runId === joined
        );
        const spent = await modelLedger(env).spendOfKeys(
          budgetMonth(env),
          "run",
          [joined, root.id]
        );
        return {
          sent: fake.requests.length,
          status: await statusOf(builder, joined),
          purposes: calls.map(({ detail }) => detail.purpose),
          // Named on the request, and counted under: App Y's account, which
          // is the run itself, as the first of App Y's runs in the lineage.
          accounts: calls.map(({ actor }) =>
            actor.type === "workflow" ? actor.accountRunId : undefined
          ),
          spentUnder: spent
            .filter(({ spentMicros }) => spentMicros > 0)
            .map(({ key }) => named(key, { joined, root: root.id })),
          joined,
        };
      }
    );

    expect({
      ...result,
      accounts: result.accounts.map((id) =>
        named(id ?? null, { joined: result.joined })
      ),
      joined: undefined,
    }).toStrictEqual({
      sent: 1,
      status: "completed",
      purposes: ["app.resource"],
      accounts: ["joined"],
      spentUnder: ["joined"],
      joined: undefined,
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
      const caught = await models(env)
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
        .parse(caught);
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
        // Released however the checks go, so no call is left open.
        const refusals: Record<string, unknown[]> = {};
        try {
          await vi.waitFor(() => {
            expect(fake.requests).toHaveLength(1);
          });
          refusals.appY = await told(appY);
          refusals.appX = await told(appX);
        } finally {
          release.resolve(true);
        }
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
});
