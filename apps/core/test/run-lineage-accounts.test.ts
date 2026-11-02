import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { modelLedger } from "../src/model-ledger.ts";
import { spendMonth } from "../src/model-spend.ts";
import { mockIdp } from "./idp.ts";
import {
  appWith,
  cheapAnswer,
  dearTotal,
  draftingFiles,
  eventsNow,
  lineageModel,
  llmStep,
  named,
  refused,
  rowsOf,
  startChild,
  startedByMail,
  statusOf,
  times,
  withProvider,
} from "./run-lineages.ts";
import { finished } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import {
  appWith as serverAppWith,
  bindModel,
  workflowFiles,
} from "./workflow-apps.ts";

// A run lineage's model spend: its runs, and the runs other Apps start
// in it, each App's counted on an account of its own. The helpers it
// shares with the other run lineage files: run-lineages.ts.

const idp = mockIdp();

/** What each of `keys` spent as a run lineage, in micros. */
const lineageSpend = async (
  keys: readonly string[]
): Promise<Map<string, number>> => {
  const spent = await modelLedger(env).spendOfKeys(
    spendMonth(env),
    "run",
    keys
  );
  return new Map(spent.map(({ key, spentMicros }) => [key, spentMicros]));
};

describe("run lineages", { timeout: 90_000 }, () => {
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

    // Three answers at one price: App Y's two runs count on its account,
    // App X's own run on the lineage's root.
    const result = await withProvider(times(3, dearTotal), async (fake) => {
      const first = await startedByMail(appY, "reader", root.id);
      await finished(first);
      const second = await startedByMail(appY, "reader", root.id);
      await finished(second);
      const own = await startChild(appX, "reader", root.id, builder.userId);
      await finished(own);
      const events = await eventsNow();
      const spent = await lineageSpend([first, root.id]);
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
        second: await statusOf(builder, second),
        own: await statusOf(builder, own),
        // Every model event of App Y's runs names its account: its first run.
        accounts: [...new Set(accounts)],
        firstId: first,
        // App Y's account spent both its runs' answers, the root its own.
        spentTwiceTheRoot:
          (spent.get(root.id) ?? 0) > 0 &&
          spent.get(first) === 2 * (spent.get(root.id) ?? 0),
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
    });
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
      sent: 3,
      first: "completed",
      second: "completed",
      own: "completed",
      accounts: ["first"],
      firstId: undefined,
      spentTwiceTheRoot: true,
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
    await bindModel(appY, "reader", lineageModel);
    const root = await builder.api.workflows.start(appX, "idle");
    await finished(root.id);

    const result = await withProvider([cheapAnswer], async (fake) => {
      const joined = await startedByMail(appY, "drafter", root.id);
      await finished(joined);
      const events = await eventsNow();
      const calls = events.filter(
        ({ action, actor }) =>
          action === "model.call" &&
          actor.type === "workflow" &&
          actor.runId === joined
      );
      const spent = await modelLedger(env).spendOfKeys(spendMonth(env), "run", [
        joined,
        root.id,
      ]);
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
    });

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

  it("charge the root's App's runs another App's mail starts back in a lineage to an account of their own, apart from the root's", async () => {
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

    // Four answers at one price: three on the account, one on the root.
    const result = await withProvider(times(4, dearTotal), async (fake) => {
      // App Y's mail starts App X's runs again, under Y's run: they
      // spend an account of their own, one for all of them.
      const back = await startedByMail(appX, "reader", joined);
      await finished(back);
      const again = await startedByMail(appX, "reader", joined);
      await finished(again);
      // ...and one of theirs starts another under it: the same account.
      const under = await startedByMail(appX, "reader", back);
      await finished(under);
      // The root's own run counts on the root.
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
      const spent = await lineageSpend([back, root.id]);
      return {
        sent: fake.requests.length,
        back: await statusOf(builder, back),
        again: await statusOf(builder, again),
        under: await statusOf(builder, under),
        own: await statusOf(builder, own),
        spentThriceTheRoot:
          (spent.get(root.id) ?? 0) > 0 &&
          spent.get(back) === 3 * (spent.get(root.id) ?? 0),
        accounts: [accountOf(back), accountOf(again), accountOf(under)].map(
          (account) => (account === back ? "back" : account)
        ),
        ownAccount: accountOf(own),
      };
    });

    expect(result).toStrictEqual({
      sent: 4,
      back: "completed",
      again: "completed",
      under: "completed",
      own: "completed",
      spentThriceTheRoot: true,
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
});
