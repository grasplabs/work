/**
 * Staff alerts, written from how they could fail first: an alert lost
 * because no channel is set, a person's content reaching the channel, a
 * storm of the same alert flooding it or the inbox, a failed send
 * silencing the next, an alert resolved while what raised it goes on, a
 * webhook that isn't Discord's posted to, or anyone but staff sending,
 * acknowledging or resolving one.
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

import {
  acknowledgeAlertFn,
  fetchAlerts,
  resolveAlertFn,
} from "../src/alert-inbox.ts";
import type { AlertView } from "../src/alert-inbox.ts";
import { alertKinds, sendStaffAlert } from "../src/alerts.ts";
import { sendTestAlertFn } from "../src/clients/functions.ts";
import { act, adminDatabase } from "../src/db/act.ts";
import { auditEvents, clients } from "../src/db/schema.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { callServerFn, page } from "./pages.ts";
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

/** The open alerts about client `clientId`, as the inbox lists them to staff. */
const inboxOf = async (clientId: string | null): Promise<AlertView[]> => {
  const open = await callServerFn(fetchAlerts);
  return open.filter((alert) => alert.clientId === clientId);
};

/** Who did `action` about client `clientId`, in order. */
const actorsOf = async (clientId: string, action: string) => {
  const events = await db
    .select({ actor: auditEvents.actor })
    .from(auditEvents)
    .where(
      and(eq(auditEvents.clientId, clientId), eq(auditEvents.action, action))
    );
  return events.map(({ actor }) => actor);
};

/** What of each open alert about client `clientId` `pick` reads. */
const inboxRead = async <T>(
  clientId: string,
  pick: (alert: AlertView) => T
): Promise<T[]> => {
  const open = await inboxOf(clientId);
  return open.map(pick);
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

  it("are kept in the inbox while there's no channel, or one that isn't Discord's, posting nothing", async () => {
    const clientId = await aClient("Acme Logistics");
    const other = await aClient("Other Company");
    await setStoreSecret(env.STAFF_ALERTS_WEBHOOK, "STAFF_ALERTS_WEBHOOK", "");
    const none = await sendStaffAlert(env, { clientId, kind: "test" }, at);
    await setStoreSecret(
      env.STAFF_ALERTS_WEBHOOK,
      "STAFF_ALERTS_WEBHOOK",
      "https://stranger.test/api/webhooks/1/x"
    );
    const stranger = await sendStaffAlert(
      env,
      { clientId: other, kind: "test" },
      at
    );

    expect({
      none,
      stranger,
      posted,
      inbox: [...(await inboxOf(clientId)), ...(await inboxOf(other))].map(
        ({ title, delivery, times }) => ({ title, delivery, times })
      ),
    }).toStrictEqual({
      none: "no_channel",
      stranger: "no_channel",
      posted: [],
      inbox: [
        { title: "Test alert", delivery: "no_channel", times: 1 },
        { title: "Test alert", delivery: "no_channel", times: 1 },
      ],
    });
  });

  it("are kept in the inbox when the channel refuses them, saying so", async () => {
    const clientId = await aClient("Acme Logistics");
    discordStatus = 500;

    const outcome = await sendStaffAlert(env, { clientId, kind: "test" }, at);

    expect({
      outcome,
      inbox: await inboxRead(clientId, ({ delivery }) => delivery),
    }).toStrictEqual({ outcome: "failed", inbox: ["failed"] });
  });

  it("keep one open in the inbox for a storm, counting each raised after its window", async () => {
    const clientId = await aClient("Acme Logistics");
    const { windowMs } = alertKinds.test;

    await Promise.all(
      Array.from(
        { length: 10 },
        async () => await sendStaffAlert(env, { clientId, kind: "test" }, at)
      )
    );
    await sendStaffAlert(env, { clientId, kind: "test" }, later(windowMs));

    await expect(
      inboxRead(clientId, ({ times, raisedAt, lastRaisedAt }) => ({
        times,
        raisedAt,
        lastRaisedAt,
      }))
    ).resolves.toStrictEqual([
      { times: 2, raisedAt: at, lastRaisedAt: later(windowMs) },
    ]);
  });

  it("are acknowledged and resolved by staff, audited, and told again once raised after being resolved", async () => {
    const clientId = await aClient("Acme Logistics");
    await sendStaffAlert(env, { clientId, kind: "test" }, at);
    const [alert] = await inboxOf(clientId);
    if (alert === undefined) {
      throw new Error("expected an open alert");
    }
    const alertId = alert.id;

    const acknowledged = await callServerFn(
      acknowledgeAlertFn,
      { alertId },
      { email: staff.email }
    );
    const [onIt] = await inboxOf(clientId);
    const resolved = await callServerFn(
      resolveAlertFn,
      { alertId },
      { email: staff.email }
    );
    const again = await callServerFn(
      resolveAlertFn,
      { alertId },
      { email: staff.email }
    );
    const afterResolving = await inboxOf(clientId);
    // Within its window still: resolved, it's told again all the same.
    const raised = await sendStaffAlert(
      env,
      { clientId, kind: "test" },
      later(1000)
    );

    expect({
      acknowledged,
      onIt: onIt?.acknowledgedBy,
      resolved,
      again,
      afterResolving,
      raised,
      reopened: await inboxRead(clientId, ({ id }) => id !== alertId),
      posted: posted.length,
      acknowledgedBy: await actorsOf(clientId, "alert.acknowledge"),
      resolvedBy: await actorsOf(clientId, "alert.resolve"),
    }).toStrictEqual({
      acknowledged: { refused: null },
      onIt: staff.email,
      resolved: { refused: null },
      again: { refused: "not_open" },
      afterResolving: [],
      raised: "sent",
      reopened: [true],
      posted: 2,
      acknowledgedBy: [staff.email],
      resolvedBy: [staff.email],
    });
  });

  it("are listed, acknowledged and resolved only for staff Access vouches for, from the admin's own pages", async () => {
    const clientId = await aClient("Acme Logistics");
    await sendStaffAlert(env, { clientId, kind: "test" }, at);
    const [alert] = await inboxOf(clientId);
    const alertId = alert?.id ?? "";

    const refusals = await Promise.allSettled([
      callServerFn(fetchAlerts, undefined, { email: null }),
      callServerFn(acknowledgeAlertFn, { alertId }, { email: null }),
      callServerFn(resolveAlertFn, { alertId }, { email: null }),
      callServerFn(
        resolveAlertFn,
        { alertId },
        { email: staff.email, from: "https://elsewhere.test" }
      ),
    ]);

    expect({
      refusals: refusals.map((each) =>
        each.status === "rejected" && each.reason instanceof Error
          ? each.reason.message
          : each.status
      ),
      open: await inboxRead(clientId, ({ acknowledgedBy }) => acknowledgedBy),
    }).toStrictEqual({
      refusals: Array.from(
        { length: 4 },
        () => "The server function answered 403"
      ),
      open: [null],
    });
  });

  it("show on Platform and Home with whom they're about, what to do next and a link there", async () => {
    const clientId = await aClient("Inbox Shown Ltd");
    await sendStaffAlert(env, { clientId, kind: "apply_failed" }, at);
    const words = alertKinds.apply_failed.words({});

    const platform = await page("/platform");
    const home = await page("/");

    for (const { html } of [platform, home]) {
      expect({
        title: html.includes("Applying settings stopped"),
        about: html.includes("Inbox Shown Ltd"),
        words: html.includes(words.replaceAll("'", "&#x27;")),
        link: html.includes(`href="/organizations/${clientId}/setup"`),
        acknowledge: html.includes(">Acknowledge<"),
        resolve: html.includes(">Resolve<"),
      }).toStrictEqual({
        title: true,
        about: true,
        words: true,
        link: true,
        acknowledge: true,
        resolve: true,
      });
    }
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
