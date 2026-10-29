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

import { adminDatabase } from "../src/db/act.ts";
import { clients } from "../src/db/schema.ts";
import worker from "../src/server.ts";
import { mockAccess } from "./access.ts";
import type { AccountState } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { emptyAdminSnapshot } from "./cloudflare-api.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { setStoreSecret, useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-digest-3b7e21";
const cloudflare = mockCloudflareApi(token);
mockAccess();

const db = adminDatabase(env.DB);
const webhook = "https://discord.com/api/webhooks/123/test-digest-token";
const digestCron = "0 6,7 * * 1-5";

/** A message as Discord's webhook takes it. */
const messageSchema = z.strictObject({
  content: z.string(),
  allowed_mentions: z.strictObject({ parse: z.array(z.string()) }),
});

/** What the fake Discord was posted: where, and each message as sent. */
const posted: { url: string; message: z.infer<typeof messageSchema> }[] = [];
/** The status the fake Discord answers with. */
let discordStatus = 204;

/**
 * Discord's webhook, in front of the stand-ins for `fetch` set up above:
 * it keeps what's posted to it, and to the stranger's host a mis-set
 * webhook could name.
 */
const mockDiscord = (): void => {
  beforeEach(() => {
    posted.length = 0;
    discordStatus = 204;
    const earlier = vi.mocked(globalThis.fetch).getMockImplementation();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const { hostname } = new URL(request.url);
      if (hostname === "discord.com" || hostname === "stranger.test") {
        posted.push({
          url: request.url,
          message: messageSchema.parse(await request.json()),
        });
        return new Response(null, { status: discordStatus });
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

/** An active client running a fresh release, as a deploy made it live. */
const liveClient = async (): Promise<{
  clientId: string;
  account: AccountState;
}> => {
  const release = await placedRelease("feat(core): the digest");
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const { account } = await livePlacedClient(cloudflare, 1, release, {
    id: clientId,
    name: `Acme ${clientId}`,
    signIn: null,
  });
  account.admin = emptyAdminSnapshot(`Acme ${clientId}`);
  return { clientId, account };
};

/** The admin's cron firing as `cron` at `at`. */
const fire = async (cron: string, at: string): Promise<void> => {
  await worker.scheduled(
    createScheduledController({ cron, scheduledTime: new Date(at) }),
    env
  );
};

describe("the morning digest in Discord", () => {
  useStoreSecrets({ deployer: token });
  mockDiscord();
  // Only each test's own clients have a core.
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.status, "active"));
  });

  it("posts the digest of every client that answers at 08:00 in Berlin, winter and summer, naming the digest as the reader and pinging nobody", async () => {
    const acme = await liveClient();
    const down = await liveClient();
    down.account.unhealthy = 1000;
    await setStoreSecret(
      env.DISCORD_DIGEST_WEBHOOK,
      "DISCORD_DIGEST_WEBHOOK",
      webhook
    );

    // A Monday in winter (CET): 07:00 UTC is 08:00 in Berlin.
    await fire(digestCron, "2026-11-02T06:00:00Z");
    await fire(digestCron, "2026-11-02T07:00:00Z");
    // A Monday in summer (CEST): 06:00 UTC is 08:00 in Berlin.
    await fire(digestCron, "2027-06-07T06:00:00Z");
    await fire(digestCron, "2027-06-07T07:00:00Z");

    expect(posted.map(({ url }) => url)).toStrictEqual([webhook, webhook]);
    const [winter, summer] = posted.map(({ message }) => message);
    expect(winter?.content).toMatch(/^Grasp, 2026-11-02: 1 organization\./u);
    expect(summer?.content).toMatch(/^Grasp, 2027-06-07: 1 organization\./u);
    expect(posted.map(({ message }) => message.allowed_mentions)).toStrictEqual(
      [{ parse: [] }, { parse: [] }]
    );
    expect(acme.account.adminReaders).toStrictEqual([
      "digest@grasp.test",
      "digest@grasp.test",
    ]);
  });

  it("sends nothing and reads no client while Secrets Store has no webhook", async () => {
    const acme = await liveClient();

    await fire(digestCron, "2026-11-02T07:00:00Z");

    expect(posted).toStrictEqual([]);
    expect(acme.account.adminReaders).toStrictEqual([]);
  });

  it("never posts to a webhook that isn't Discord's", async () => {
    const acme = await liveClient();
    await setStoreSecret(
      env.DISCORD_DIGEST_WEBHOOK,
      "DISCORD_DIGEST_WEBHOOK",
      "https://stranger.test/api/webhooks/123/token"
    );

    await fire(digestCron, "2026-11-02T07:00:00Z");

    expect(posted).toStrictEqual([]);
    expect(acme.account.adminReaders).toStrictEqual([]);
  });

  it("fails the run when Discord refuses the digest", async () => {
    await liveClient();
    await setStoreSecret(
      env.DISCORD_DIGEST_WEBHOOK,
      "DISCORD_DIGEST_WEBHOOK",
      webhook
    );
    discordStatus = 404;

    await expect(fire(digestCron, "2026-11-02T07:00:00Z")).rejects.toThrow(
      "Discord refused the morning digest: 404"
    );
  });

  it("leaves release imports on the five-minute cron", async () => {
    await liveClient();
    await setStoreSecret(
      env.DISCORD_DIGEST_WEBHOOK,
      "DISCORD_DIGEST_WEBHOOK",
      webhook
    );

    await fire("*/5 * * * *", "2026-11-02T07:00:00Z");

    expect(posted).toStrictEqual([]);
  });
});
