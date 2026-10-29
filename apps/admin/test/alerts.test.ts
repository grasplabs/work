/**
 * Staff alerts, written from how they could fail first: a person's
 * content reaching the channel, a storm of the same alert flooding it, a
 * failed send silencing the next, a webhook that isn't Discord's posted
 * to, or anyone but staff sending one.
 */
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { z } from "zod";

import { alertKinds, sendStaffAlert } from "../src/alerts.ts";
import { sendTestAlertFn } from "../src/clients/functions.ts";
import { act, adminDatabase } from "../src/db/act.ts";
import { auditEvents, clients } from "../src/db/schema.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { callServerFn } from "./pages.ts";
import { setStoreSecret, useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-alerts-6d1a09";
mockCloudflareApi(token);
mockAccess();

const db = adminDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };
const webhook = "https://discord.com/api/webhooks/456/test-alerts-token";

/** A message as Discord's webhook takes it. */
const messageSchema = z.strictObject({
  content: z.string(),
  allowed_mentions: z.strictObject({ parse: z.array(z.string()) }),
});

/** What the fake Discord was posted, each message as sent. */
const posted: { url: string; message: z.infer<typeof messageSchema> }[] = [];
/** The status the fake Discord answers with. */
let discordStatus = 204;

/** Discord's webhook, and the stranger's host a mis-set webhook could name. */
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

/** A client the admin keeps, named `name`. */
const aClient = async (name: string): Promise<string> => {
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id: clientId,
        name,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  return clientId;
};

const at = new Date("2026-11-02T09:00:00Z");
const later = (ms: number): Date => new Date(at.getTime() + ms);

describe("staff alerts", () => {
  useStoreSecrets({ deployer: token });
  mockDiscord();
  beforeEach(async () => {
    await setStoreSecret(
      env.STAFF_ALERTS_WEBHOOK,
      "STAFF_ALERTS_WEBHOOK",
      webhook
    );
  });

  it("reach the channel with the client, its kind and a link to its page, pinging nobody", async () => {
    const clientId = await aClient("Acme Logistics");

    const outcome = await sendStaffAlert(
      { ...env, ADMIN_HOST: "admin.grasp.test" },
      { clientId, kind: "test" },
      at
    );

    expect({ outcome, posted }).toStrictEqual({
      outcome: "sent",
      posted: [
        {
          url: webhook,
          message: {
            content: [
              `**Test alert**: Acme Logistics (${clientId})`,
              alertKinds.test.words({}),
              `https://admin.grasp.test/organizations/${clientId}/setup`,
            ].join("\n"),
            allowed_mentions: { parse: [] },
          },
        },
      ],
    });
  });

  it("send one of ten of the same client and kind at once, and the next only after its window", async () => {
    const clientId = await aClient("Acme Logistics");
    const other = await aClient("Other Company");
    const { windowMs } = alertKinds.test;

    const storm = await Promise.all(
      Array.from(
        { length: 10 },
        async () => await sendStaffAlert(env, { clientId, kind: "test" }, at)
      )
    );
    const otherClient = await sendStaffAlert(
      env,
      { clientId: other, kind: "test" },
      at
    );
    const within = await sendStaffAlert(
      env,
      { clientId, kind: "test" },
      later(windowMs - 1)
    );
    const after = await sendStaffAlert(
      env,
      { clientId, kind: "test" },
      later(windowMs)
    );

    expect({
      sent: storm.filter((outcome) => outcome === "sent").length,
      held: storm.filter((outcome) => outcome === "held").length,
      otherClient,
      within,
      after,
      posted: posted.length,
    }).toStrictEqual({
      sent: 1,
      held: 9,
      otherClient: "sent",
      within: "held",
      after: "sent",
      posted: 3,
    });
  });

  it("try again at the next alert when the channel refused the last", async () => {
    const clientId = await aClient("Acme Logistics");
    discordStatus = 500;
    const refused = await sendStaffAlert(env, { clientId, kind: "test" }, at);
    discordStatus = 204;
    const next = await sendStaffAlert(env, { clientId, kind: "test" }, at);

    expect({ refused, next, posted: posted.length }).toStrictEqual({
      refused: "failed",
      next: "sent",
      posted: 2,
    });
  });

  it("are only logged while there's no channel, or one that isn't Discord's", async () => {
    const clientId = await aClient("Acme Logistics");
    await setStoreSecret(env.STAFF_ALERTS_WEBHOOK, "STAFF_ALERTS_WEBHOOK", "");
    const none = await sendStaffAlert(env, { clientId, kind: "test" }, at);
    await setStoreSecret(
      env.STAFF_ALERTS_WEBHOOK,
      "STAFF_ALERTS_WEBHOOK",
      "https://stranger.test/api/webhooks/1/x"
    );
    const stranger = await sendStaffAlert(env, { clientId, kind: "test" }, at);

    expect({ none, stranger, posted }).toStrictEqual({
      none: "no_channel",
      stranger: "no_channel",
      posted: [],
    });
  });

  it("carry nothing but their kind's words, the client and numbers: no person's content", async () => {
    const clientId = await aClient("Acme Logistics");
    const content = "Lisa's mail about the Q3 numbers";

    // Numbers alone are taken: words don't type-check, and none reach it.
    await sendStaffAlert(
      env,
      {
        clientId,
        kind: "test",
        // @ts-expect-error -- an alert takes numbers, never words
        numbers: { said: content },
      },
      at
    );

    expect({
      posted: posted.length,
      leaked: posted.some(({ message }) => message.content.includes(content)),
    }).toStrictEqual({ posted: 1, leaked: false });
  });

  it("are sent as a test only by staff Access vouches for, from the admin's own pages, audited as them", async () => {
    const clientId = await aClient("Acme Logistics");

    await expect(
      callServerFn(sendTestAlertFn, { clientId }, { email: null })
    ).rejects.toThrow("The server function answered 403");
    await expect(
      callServerFn(
        sendTestAlertFn,
        { clientId },
        { email: staff.email, from: "https://elsewhere.test" }
      )
    ).rejects.toThrow("The server function answered 403");
    const outcome = await callServerFn(
      sendTestAlertFn,
      { clientId },
      { email: staff.email }
    );
    const events = await db
      .select({ actor: auditEvents.actor })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.clientId, clientId),
          eq(auditEvents.action, "alert.test")
        )
      );

    expect({ outcome, posted: posted.length, events }).toStrictEqual({
      outcome: "sent",
      posted: 1,
      events: [{ actor: staff.email }],
    });
  });
});
