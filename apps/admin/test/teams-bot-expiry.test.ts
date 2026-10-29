/**
 * Warning staff before a client's Teams bot secret expires, on a fixed
 * clock through the admin's own cron. Written from how a warning could be
 * missed or repeated: a stage skipped, told twice, a missed day never
 * caught up, a new secret never warned of, or a client without a bot
 * alerted about.
 */
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

import { setTeamsBot } from "../src/clients/settings.ts";
import { act, adminDatabase } from "../src/db/act.ts";
import { clients } from "../src/db/schema.ts";
import worker from "../src/server.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { setStoreSecret, useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-expiry-9e3b41";
mockCloudflareApi(token);
mockAccess();

const db = adminDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };
const webhook = "https://discord.com/api/webhooks/789/test-expiry-token";
const expiryCron = "15 7 * * *";
const dayMs = 24 * 60 * 60 * 1000;

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

/** Sets client `clientId`'s bot, its secret expiring on `expires`. */
const setBot = async (clientId: string, expires: string): Promise<void> => {
  await setTeamsBot(env, staff, {
    clientId,
    bot: {
      appId: crypto.randomUUID(),
      tenantId: crypto.randomUUID(),
      secretExpiresOn: expires,
    },
  });
};

/** An active client the admin keeps, with a bot whose secret expires on `expires`, if given. */
const aClient = async (expires?: string): Promise<string> => {
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id: clientId,
        name: clientId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  if (expires !== undefined) {
    await setBot(clientId, expires);
  }
  return clientId;
};

/** Runs the expiry cron on the day `day` (YYYY-MM-DD), at its hour. */
const runOn = async (day: string): Promise<void> => {
  await worker.scheduled(
    createScheduledController({
      cron: expiryCron,
      scheduledTime: Date.parse(`${day}T07:15:00Z`),
    }),
    env
  );
};

/** The day `days` after `day`. */
const plus = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * dayMs)
    .toISOString()
    .slice(0, 10);

/** What the posts about client `clientId` said of its days left, in order. */
const toldOf = (clientId: string): string[] =>
  posted
    .filter((text) => text.includes(clientId))
    .map((text) => text.split("\n")[1] ?? "");

describe("a client's Teams bot secret expiring", () => {
  useStoreSecrets({ deployer: token });
  mockDiscord();
  beforeEach(async () => {
    await setStoreSecret(
      env.STAFF_ALERTS_WEBHOOK,
      "STAFF_ALERTS_WEBHOOK",
      webhook
    );
    // An earlier test's clients are gone: their alerts aren't this one's.
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.status, "active"));
  });

  it("is told 60, 30 and 7 days before and on the day, each once, through every day of the cron, twice a day included; never for a client without a bot", async () => {
    const expires = "2027-04-30";
    const acme = await aClient(expires);
    const without = await aClient();
    // Every day from 70 days before to 3 after, each run twice.
    for (let day = -70; day <= 3; day += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one day after another
      await runOn(plus(expires, day));
      // oxlint-disable-next-line no-await-in-loop -- one day after another
      await runOn(plus(expires, day));
    }

    expect({
      acme: toldOf(acme),
      without: toldOf(without),
      titled: posted.every((text) =>
        text.includes(`**Teams bot secret expiring**`)
      ),
    }).toStrictEqual({
      acme: [
        expect.stringContaining("expires in 60 days"),
        expect.stringContaining("expires in 30 days"),
        expect.stringContaining("expires in 7 days"),
        expect.stringContaining("expires today"),
      ],
      without: [],
      titled: true,
    });
  });

  it("catches a stage up on the next run when its day was missed, once", async () => {
    const expires = "2027-04-30";
    const acme = await aClient(expires);
    await runOn(plus(expires, -59));
    await runOn(plus(expires, -58));
    // Past the day itself, and never told it: told it has expired.
    const late = await aClient("2027-01-10");
    await runOn("2027-01-12");

    expect({ acme: toldOf(acme), late: toldOf(late) }).toStrictEqual({
      acme: [expect.stringContaining("expires in 59 days")],
      late: [expect.stringContaining("has expired")],
    });
  });

  it("starts over for a new secret, set with its new expiry day", async () => {
    const acme = await aClient("2027-04-30");
    await runOn("2027-04-23");
    await setBot(acme, "2029-04-20");
    await runOn("2027-04-24");
    await runOn("2029-02-19");

    expect(toldOf(acme)).toStrictEqual([
      expect.stringContaining("expires in 7 days"),
      expect.stringContaining("expires in 60 days"),
    ]);
  });
});
