/**
 * The admin's hourly watch of Stephen at every client (src/clients/watch.ts),
 * through its own cron, against fake client cores and a fake Discord.
 * Written from how watching could fail: a signal over its bar nobody is
 * told of, told again every hour while it stays over, never told again
 * once it came back and went over again, a client nobody watches because
 * its core is older, or what the watch read not on the client's page.
 */
import type {
  AdminSnapshot,
  AdminStephenSignals,
} from "@grasp-os/shared/admin-snapshot";
import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { z } from "zod";

import { fetchAlerts } from "../src/alert-inbox.ts";
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
import { callServerFn } from "./pages.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { setStoreSecret, useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-watch-7a2c90";
const cloudflare = mockCloudflareApi(token);
mockAccess();

const db = adminDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };
const webhook = "https://discord.com/api/webhooks/321/test-watch-token";
const watchCron = "45 * * * *";

const messageSchema = z.object({ content: z.string() }).loose();

/** Each message the fake Discord was posted, as its text. */
const posted: string[] = [];

/** Discord's webhook, keeping what's posted to it. */
const mockDiscord = (): void => {
  beforeEach(() => {
    posted.length = 0;
    const earlier = vi.mocked(globalThis.fetch).getMockImplementation();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).hostname === "discord.com") {
        posted.push(messageSchema.parse(await request.json()).content);
        return new Response(null, { status: 204 });
      }
      if (earlier === undefined) {
        throw new Error(`Unexpected outbound request to ${request.url}`);
      }
      return await earlier(input, init);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
};

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

/** The titles of the open alerts about client `clientId`, as the inbox lists them. */
const inboxOf = async (clientId: string): Promise<string[]> => {
  const open = await callServerFn(fetchAlerts);
  return open
    .filter((alert) => alert.clientId === clientId)
    .map(({ title }) => title);
};

/** Runs the watch's cron once. */
const watch = async (): Promise<void> => {
  await worker.scheduled(
    createScheduledController({ cron: watchCron, scheduledTime: Date.now() }),
    env
  );
};

/** The posts about client `clientId`, by their title. */
const toldOf = (clientId: string): string[] =>
  posted
    .filter((text) => text.includes(clientId))
    .map((text) => text.split("\n")[0] ?? "");

describe("the watch of Stephen", () => {
  useStoreSecrets({ deployer: token });
  mockDiscord();
  beforeEach(async () => {
    await setStoreSecret(
      env.STAFF_ALERTS_WEBHOOK,
      "STAFF_ALERTS_WEBHOOK",
      webhook
    );
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.status, "active"));
  });

  it("tells staff once of a count over its bar, not again while it stays over, and again once it went back and over again", async () => {
    const acme = await liveClient();
    const calm = await liveClient();
    answering(acme.account, { ...quiet, failed: 10 });
    answering(calm.account, quiet);

    await watch();
    await watch();
    const whileOver = toldOf(acme.clientId);
    const openWhileOver = await inboxOf(acme.clientId);
    answering(acme.account, quiet);
    await watch();
    const openOnceUnder = await inboxOf(acme.clientId);
    answering(acme.account, { ...quiet, failed: 12 });
    await watch();

    expect({
      whileOver,
      // The inbox has it while it's over, and the watch resolves it once under.
      openWhileOver,
      openOnceUnder,
      openAgain: await inboxOf(acme.clientId),
      after: toldOf(acme.clientId),
      calm: toldOf(calm.clientId),
      words: posted
        .find((text) => text.includes(acme.clientId))
        ?.split("\n")[1],
    }).toStrictEqual({
      whileOver: [
        `**Stephen: turns failing**: Acme ${acme.clientId} (${acme.clientId})`,
      ],
      openWhileOver: ["Stephen: turns failing"],
      openOnceUnder: [],
      openAgain: ["Stephen: turns failing"],
      after: [
        `**Stephen: turns failing**: Acme ${acme.clientId} (${acme.clientId})`,
        `**Stephen: turns failing**: Acme ${acme.clientId} (${acme.clientId})`,
      ],
      calm: [],
      words:
        "10 of 50 turns in the last day ended in Stephen's line for a failure.",
    });
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
      told: [...toldOf(acme.clientId), ...toldOf(older.clientId)],
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
      told: [
        `**Stephen: answers slow**: Acme ${acme.clientId} (${acme.clientId})`,
      ],
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
