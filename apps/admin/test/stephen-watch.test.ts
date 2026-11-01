/**
 * The admin's hourly watch of Stephen at every client (src/clients/watch.ts),
 * through its own cron, against fake client cores.
 * Written from how watching could fail: a signal over its bar the client's
 * Setup doesn't say needs a look, or still says so once it's back under, a
 * client nobody watches because its core is older, or what the watch read
 * not on the client's page.
 */
import type {
  AdminSnapshot,
  AdminStephenSignals,
} from "@grasp-os/shared/admin-snapshot";
import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { fetchClientSetup } from "../src/clients/functions.ts";
import { overBars } from "../src/clients/watch-signals.ts";
import type { WatchedSignals } from "../src/clients/watch-signals.ts";
import { adminDatabase } from "../src/db/act.ts";
import { clients } from "../src/db/schema.ts";
import worker from "../src/server.ts";
import { mockAccess } from "./access.ts";
import type { AccountState } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { emptyAdminSnapshot } from "./cloudflare-api.ts";
import { callServerFn, page } from "./pages.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-watch-7a2c90";
const cloudflare = mockCloudflareApi(token);
mockAccess();

const db = adminDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };
const watchCron = "45 * * * *";

/** A day of Stephen with nothing amiss: answers, quick. */
const quiet: AdminStephenSignals = {
  hours: 24,
  refused: 2,
  answered: 40,
  failed: 1,
  overBudget: 0,
  busy: 0,
  sendFailed: 0,
  uninstalled: 0,
  p50Ms: 4000,
  p90Ms: 8000,
};

/** An active client running a fresh release, as a deploy made it live. */
const liveClient = async (): Promise<{
  clientId: string;
  account: AccountState;
}> => {
  const release = await placedRelease("feat(core): count Stephen");
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const { account } = await livePlacedClient(cloudflare, 1, release, {
    id: clientId,
    name: `Acme ${clientId}`,
    signIn: null,
  });
  return { clientId, account };
};

/** What `account`'s core answers: its company, and Stephen's counts. */
const answering = (
  account: AccountState,
  stephen?: AdminStephenSignals
): void => {
  const snapshot: AdminSnapshot = {
    ...emptyAdminSnapshot(account.name),
    ...(stephen === undefined ? {} : { stephen }),
  };
  account.admin = snapshot;
};

/** Runs the watch's cron once. */
const watch = async (): Promise<void> => {
  await worker.scheduled(
    createScheduledController({ cron: watchCron, scheduledTime: Date.now() }),
    env
  );
};

/** The needs client `clientId`'s Setup lists, as staff see the page. */
const needsOf = async (clientId: string): Promise<string> => {
  const { html } = await page(`/organizations/${clientId}/setup`, staff.email);
  return html.replaceAll("&#x27;", "'");
};

/** What Stephen's need says, with `over` signals over their bar. */
const overWords = (over: number): string =>
  over === 1
    ? "One of Stephen's signals is over its bar"
    : `${over} of Stephen's signals are over its bar`;

describe("the watch of Stephen", () => {
  useStoreSecrets({ deployer: token });
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.status, "active"));
  });

  it("says on the client's Setup that a signal is over its bar, until it's back under", async () => {
    const acme = await liveClient();
    const calm = await liveClient();
    answering(acme.account, { ...quiet, failed: 10 });
    answering(calm.account, quiet);

    await watch();
    const whileOver = await needsOf(acme.clientId);
    const calmPage = await needsOf(calm.clientId);
    answering(acme.account, quiet);
    await watch();
    const onceUnder = await needsOf(acme.clientId);

    expect({
      whileOver: whileOver.includes(overWords(1)),
      calm: calmPage.includes("over its bar:"),
      onceUnder: onceUnder.includes("over its bar:"),
    }).toStrictEqual({ whileOver: true, calm: false, onceUnder: false });
  });

  it("puts what it read on the client's page, a line a signal, and leaves a client whose core doesn't count Stephen yet unwatched", async () => {
    const acme = await liveClient();
    const older = await liveClient();
    answering(acme.account, { ...quiet, p90Ms: 15_000 });
    answering(older.account);

    await watch();

    const [acmeSetup, olderSetup] = await Promise.all(
      [acme.clientId, older.clientId].map(
        async (clientId) =>
          await callServerFn(
            fetchClientSetup,
            { clientId },
            { email: staff.email }
          )
      )
    );
    expect({
      acme: acmeSetup?.watched?.signals,
      older: olderSetup?.watched,
    }).toStrictEqual({
      acme: {
        hours: 24,
        answered: 40,
        failed: 1,
        refused: 2,
        overBudget: 0,
        busy: 0,
        sendFailed: 0,
        uninstalled: 0,
        p50Ms: 4000,
        p90Ms: 15_000,
        companyAgain: 0,
        personalAgain: 0,
      },
      older: null,
    });
  });
});

describe("each of Stephen's bars", () => {
  const calm: WatchedSignals = {
    ...quiet,
    sendFailed: 0,
    companyAgain: 0,
    personalAgain: 0,
  };

  it("is over for what a person at Grasp should look at, and under for a quiet day", () => {
    const cases: [string, Partial<WatchedSignals>][] = [
      ["stephen_refused", { refused: 21 }],
      ["stephen_failing", { failed: 6 }],
      ["stephen_slow", { p90Ms: 15_000 }],
      ["stephen_over_budget", { overBudget: 1 }],
      ["stephen_busy", { busy: 11 }],
      ["stephen_sends_failing", { sendFailed: 1 }],
      ["stephen_uninstalled", { uninstalled: 3 }],
      ["stephen_connections_again", { companyAgain: 1 }],
      ["stephen_connections_again", { personalAgain: 5 }],
    ];

    expect({
      quiet: [...overBars(calm)],
      // Too few turns or answers to say anything by.
      few: [...overBars({ ...calm, answered: 2, failed: 2, p90Ms: 30_000 })],
      each: cases.map(([, changes]) => [...overBars({ ...calm, ...changes })]),
    }).toStrictEqual({
      quiet: [],
      few: [],
      each: cases.map(([kind]) => [kind]),
    });
  });
});
