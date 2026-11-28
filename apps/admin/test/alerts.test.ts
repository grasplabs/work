import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { alert, deliverAlerts, MAX_ATTEMPTS } from "../src/alerts/alert.ts";
import { sendTestAlert } from "../src/alerts/channels.ts";
import type { DiscordEmbed } from "../src/alerts/discord.ts";
import {
  fetchAlertChannelsFn,
  sendTestAlertFn,
  switchAlertChannelFn,
} from "../src/alerts/functions.ts";
import { adminDatabase } from "../src/db/act.ts";
import {
  alertChannels,
  alerts,
  auditEvents,
  clientDeploys,
  leases,
  releases,
} from "../src/db/schema.ts";
import { importReleases } from "../src/releases/import.ts";
import { recordEnd } from "../src/rollout/deploy.ts";
import { mockAccess } from "./access.ts";
import { client } from "./hosting.ts";
import { callServerFn } from "./pages.ts";
import { maintenancePage } from "./platform-page.ts";
import { buildRelease, putBlobs, putManifest } from "./releases.ts";
import { setStoreSecret, useStoreSecrets } from "./secrets-store.ts";

const db = adminDatabase(env.DB);
const staff = { email: "ops@grasp.test" };
/** The alerts' Discord webhook; never a real one. */
const webhook =
  "https://discord.com/api/webhooks/1234567890/alerts-test-token-5b7c";

/** A post to Discord's webhook, as the fake keeps it. */
interface DiscordPost {
  content?: string;
  embeds?: DiscordEmbed[];
  allowed_mentions: unknown;
}

/** Each card's title in `posts`, a post's cards together. */
const titlesOf = (posts: readonly DiscordPost[]) =>
  posts.map(({ embeds }) => embeds?.map(({ title }) => title));

/**
 * What Discord was sent, how each request would follow a redirect, and
 * how it answers: 204 unless a test says otherwise.
 */
const discord: {
  posts: DiscordPost[];
  redirects: RequestRedirect[];
  answer: () => Response;
} = {
  posts: [],
  redirects: [],
  answer: () => new Response(null, { status: 204 }),
};

/**
 * The alert mail's binding as a deploy binds it, keeping each message it
 * was given; `whileSending` runs while a message is on its way.
 */
const mailbox = (whileSending?: () => Promise<void>) => {
  const sent: EmailMessageBuilder[] = [];
  const binding: SendEmail = {
    send: async (message: EmailMessage | EmailMessageBuilder) => {
      // Taken a moment later, as Email Sending takes a message.
      await (whileSending?.() ?? Promise.resolve());
      if ("subject" in message) {
        sent.push(message);
      }
      return { messageId: `message-${sent.length}` };
    },
  };
  return {
    sent,
    env: {
      ...env,
      ALERTS_MAIL: binding,
      ALERTS_MAIL_FROM: "alerts@mail.grasp.test",
      ALERTS_MAIL_TO: "alerts@grasp.test",
    },
  };
};

/** Switches channel `channel` on or off, as staff do on the Maintenance page. */
const switchChannel = async (channel: "mail" | "discord", on: boolean) => {
  await callServerFn(switchAlertChannelFn, { channel, on }, staff);
};

/** The Discord webhook in Secrets Store, as Deploy platform puts it there. */
const withWebhook = async () => {
  await setStoreSecret(
    env.DISCORD_ALERTS_WEBHOOK,
    "DISCORD_ALERTS_WEBHOOK",
    webhook
  );
};

/** A release record of id `id`, as an import leaves one. */
const releaseRecord = async (id: string) => {
  await db
    .insert(releases)
    .values({
      id,
      commitSha: "0".repeat(40),
      manifest: "{}",
      manifestSha256: "0".repeat(64),
      builtAt: new Date(),
      importedAt: new Date(),
    })
    .onConflictDoNothing();
};

/** Client `clientId`'s deploy of `releaseId` as a run of its own, ended with `error` (null: it worked). */
const deployEnded = async (
  clientId: string,
  releaseId: string,
  error: string | null
) => {
  await releaseRecord(releaseId);
  const runId = `run-${crypto.randomUUID().slice(0, 8)}`;
  await db.delete(clientDeploys).where(eq(clientDeploys.clientId, clientId));
  await db.insert(clientDeploys).values({
    clientId,
    releaseId,
    runId,
    status: "deploying",
    startedAt: new Date(),
  });
  await recordEnd(db, { clientId, runId, releaseId }, error);
};

/** Runs an import at `now`, with the failures it logs kept out of the test output. */
const runImport = async (now: Date) => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {
    // Failed imports are logged; the tests read the alerts instead.
  });
  try {
    return await importReleases(env.RELEASES, db, { now });
  } finally {
    errors.mockRestore();
  }
};

/** Delivers as the cron's runs do, with the refusals it logs kept out of the test output. */
const deliver = async (on: Env = env) => {
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {
    // Refusals are logged; the tests read what each channel got.
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {
    // Giving up is logged too.
  });
  try {
    await deliverAlerts(on);
  } finally {
    warnings.mockRestore();
    errors.mockRestore();
  }
};

describe("staff alerts", () => {
  // A stand-in for Discord's webhook, set up before Access's stand-in,
  // which passes every other request on to it.
  beforeEach(async () => {
    discord.posts = [];
    discord.answer = () => new Response(null, { status: 204 });
    discord.redirects = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== webhook) {
        throw new Error(`Unexpected outbound request to ${request.url}`);
      }
      discord.redirects.push(request.redirect);
      discord.posts.push(await request.json());
      return discord.answer();
    });
    await db.delete(alerts);
    await db.delete(alertChannels);
  });
  mockAccess();
  useStoreSecrets({ deployer: "test-deployer-token-alerts-3c9e" });

  it("tells each channel that's on of a release that didn't import, once however often it fails, and once of its import", async () => {
    const mail = mailbox();
    await withWebhook();
    await switchChannel("mail", true);
    await switchChannel("discord", true);
    const release = await buildRelease({
      notes: "feat(core): alerts on a missing blob",
      migrations: {
        "0000_only.sql": `-- ${crypto.randomUUID()}
CREATE TABLE t (id TEXT);`,
      },
    });
    const [key, bytes] =
      [...release.blobs].find(([blobKey]) =>
        blobKey.startsWith("blobs/migrations/")
      ) ?? [];
    if (key === undefined || bytes === undefined) {
      throw new Error("expected a migration");
    }
    await putBlobs(release);
    await env.RELEASES.delete(key);
    await putManifest(release);
    const start = Date.now();
    const minutes = (count: number) => new Date(start + count * 60_000);

    // Three failed attempts, each run delivering after it.
    for (const at of [0, 1, 3]) {
      // oxlint-disable-next-line no-await-in-loop -- runs in order
      await runImport(minutes(at));
      // oxlint-disable-next-line no-await-in-loop -- runs in order
      await deliver(mail.env);
    }
    const whileFailing = {
      mail: mail.sent.map(({ subject }) => subject),
      discord: discord.posts.length,
    };
    await env.RELEASES.put(key, bytes);
    await runImport(minutes(10));
    await deliver(mail.env);
    await deliver(mail.env);

    expect({
      whileFailing,
      mail: mail.sent.map(({ subject, to }) => ({ subject, to })),
      discord: titlesOf(discord.posts),
    }).toStrictEqual({
      whileFailing: {
        mail: [`Release ${release.id} didn't import`],
        discord: 1,
      },
      mail: [
        {
          subject: `Release ${release.id} didn't import`,
          to: "alerts@grasp.test",
        },
        { subject: `Release ${release.id} imported`, to: "alerts@grasp.test" },
      ],
      discord: [
        [`Release didn't import: ${release.id}`],
        [`Release imported: ${release.id}`],
      ],
    });
    // Told and recovered: nothing of it is kept.
    await expect(db.select().from(alerts)).resolves.toStrictEqual([]);
  });

  it("tells of a failed deploy once, with the organization, release, code and its Setup, pinging nobody, and of the next deploy that works", async () => {
    await withWebhook();
    await switchChannel("discord", true);
    const clientId = await client();

    // The admin on its own hostname, which the links name.
    const hosted = { ...env, ADMIN_HOST: "admin.grasp.test" };

    await deployEnded(clientId, "26.11.7", "release_rolled_back");
    await deliver(hosted);
    await deployEnded(clientId, "26.11.7", "release_rolled_back");
    await deliver(hosted);
    await deployEnded(clientId, "26.11.8", null);
    await deliver(hosted);
    // Another deploy that works says nothing more.
    await deployEnded(clientId, "26.11.9", null);
    await deliver(hosted);

    const setup = `https://admin.grasp.test/organizations/${clientId}/setup`;
    // Its name (its id here) shown as typed: Discord's markdown escaped.
    const shownName = clientId.replaceAll("-", "\\-");
    expect(
      discord.posts.map(({ embeds, allowed_mentions }) => ({
        allowed_mentions,
        cards: embeds?.map(({ title, url, color, fields, description }) => ({
          title,
          url,
          color,
          fields: fields.map(({ name }) => name),
          link: description.endsWith(`[Open in admin](${setup})`),
        })),
      }))
    ).toStrictEqual([
      {
        allowed_mentions: { parse: [] },
        cards: [
          {
            title: `Deploy failed: ${shownName}`,
            url: setup,
            color: 0xed_42_45,
            fields: [
              "Organization",
              "Release",
              "Channel",
              "Failure code",
              "Since",
              "Stage",
            ],
            link: true,
          },
        ],
      },
      {
        allowed_mentions: { parse: [] },
        cards: [
          {
            title: `Deploy recovered: ${shownName}`,
            url: setup,
            color: 0x57_f2_87,
            fields: [
              "Organization",
              "Release",
              "Channel",
              "Failing for",
              "Stage",
            ],
            link: true,
          },
        ],
      },
    ]);
    const [failure] = discord.posts[0]?.embeds ?? [];
    expect(failure?.fields.slice(0, 4).map(({ value }) => value)).toStrictEqual(
      [
        `${shownName}\n\`${clientId}\``,
        "26.11.7",
        "Stable",
        "`release_rolled_back`",
      ]
    );
  });

  it("tells of a rollout's halt and of a 429 block once each, however often a pass sees them, and of a halt after a resume again", async () => {
    const mail = mailbox();
    await switchChannel("mail", true);
    const halt = {
      kind: "rollout_halted",
      rolloutId: "r-alerted",
      channel: "stable",
      releaseId: "26.11.7",
      done: 4,
      failed: 3,
      since: 1000,
    } as const;
    const block = {
      kind: "rollout_blocked",
      until: Date.UTC(2026, 10, 28, 10, 5),
    } as const;

    await alert(db, halt);
    await alert(db, block);
    await deliver(mail.env);
    await alert(db, halt);
    await alert(db, block);
    await deliver(mail.env);
    // Resumed at 2000, and halted again.
    await alert(db, { ...halt, failed: 4, since: 2000 });
    await deliver(mail.env);

    expect(
      mail.sent.map(({ subject, text }) => ({ subject, text }))
    ).toStrictEqual([
      {
        subject: "Stable rollout of 26.11.7 halted",
        text: "The Stable rollout of release 26.11.7 halted: 3 organizations failed on it since it started or was last resumed (4 done). Nothing new starts on Stable until staff resume it, or promote another release.",
      },
      {
        subject: "Rollouts paused by Cloudflare's rate limit",
        text: "Cloudflare refused the deployer token for making too many requests. No organization starts deploying until 2026-11-28T10:05:00.000Z; the runs out wait it out.",
      },
      {
        subject: "Stable rollout of 26.11.7 halted",
        text: "The Stable rollout of release 26.11.7 halted: 4 organizations failed on it since it started or was last resumed (4 done). Nothing new starts on Stable until staff resume it, or promote another release.",
      },
    ]);
  });

  it("never tells a channel switched on after the change, nor one switched off since", async () => {
    const mail = mailbox();
    await withWebhook();
    await switchChannel("discord", true);
    await alert(db, {
      kind: "deploy_failed",
      clientId: "nobody-told",
      releaseId: "26.11.1",
      code: "probe_failed",
    });
    await switchChannel("mail", true);
    await switchChannel("discord", false);
    await deliver(mail.env);
    await switchChannel("discord", true);
    await deliver(mail.env);

    expect({ mail: mail.sent, discord: discord.posts }).toStrictEqual({
      mail: [],
      discord: [],
    });
  });

  it("keeps a change for a channel that's on but can't send yet, and sends it once it can", async () => {
    await switchChannel("discord", true);
    await alert(db, {
      kind: "import_failed",
      releaseId: "26.11.4",
      code: "Error",
      attempt: 1,
    });

    // Its webhook isn't there (or can't be read) yet.
    await deliver();
    const before = discord.posts.length;
    await withWebhook();
    await deliver();

    expect({ before, after: titlesOf(discord.posts) }).toStrictEqual({
      before: 0,
      after: [["Release didn't import: 26.11.4"]],
    });
  });

  it("drops a recovery with its failure when no channel took the failure", async () => {
    // Discord on, but its webhook isn't there yet: the failure waits.
    await switchChannel("discord", true);
    const clientId = "nobody-told-recovered";
    await alert(db, {
      kind: "deploy_failed",
      clientId,
      releaseId: "26.11.5",
      code: "probe_failed",
    });
    await deliver();
    await alert(db, { kind: "deployed", clientId, releaseId: "26.11.6" });
    const rows = await db.select().from(alerts);
    await withWebhook();
    await deliver();

    expect({ rows, discord: discord.posts }).toStrictEqual({
      rows: [],
      discord: [],
    });
  });

  it("sends a recovery to exactly the channels that took the failure, not one still waiting on it", async () => {
    const mail = mailbox();
    await withWebhook();
    await switchChannel("mail", true);
    await switchChannel("discord", true);
    discord.answer = () => new Response("busy", { status: 500 });
    await alert(db, {
      kind: "import_failed",
      releaseId: "26.11.6",
      code: "Error",
      attempt: 1,
    });
    // Mail takes the failure; Discord refuses it.
    await deliver(mail.env);
    const discordTries = discord.posts.length;
    await alert(db, { kind: "imported", releaseId: "26.11.6" });
    discord.answer = () => new Response(null, { status: 204 });
    await deliver(mail.env);
    await deliver(mail.env);

    expect({
      mail: mail.sent.map(({ subject }) => subject),
      discordTries,
      discordAfter: discord.posts.length,
      rows: await db.select().from(alerts),
    }).toStrictEqual({
      mail: ["Release 26.11.6 didn't import", "Release 26.11.6 imported"],
      discordTries: 1,
      discordAfter: 1,
      rows: [],
    });
  });

  it("keeps no row once a failure recovers while both channels are off", async () => {
    await alert(db, {
      kind: "deploy_failed",
      clientId: "both-off",
      releaseId: "26.11.7",
      code: "probe_failed",
    });
    const failingRows = await db.select().from(alerts);
    const whileFailing = failingRows.length;
    await alert(db, {
      kind: "deployed",
      clientId: "both-off",
      releaseId: "26.11.8",
    });

    expect({
      whileFailing,
      after: await db.select().from(alerts),
    }).toStrictEqual({ whileFailing: 1, after: [] });
  });

  it("sends the recovery to a channel whose failure was on its way when the recovery came", async () => {
    let recovered = false;
    const mail = mailbox(async () => {
      if (!recovered) {
        recovered = true;
        // The deploy that works lands while the failure's mail is sent.
        await alert(db, {
          kind: "deployed",
          clientId: "in-flight",
          releaseId: "26.11.10",
        });
      }
    });
    await switchChannel("mail", true);
    await alert(db, {
      kind: "deploy_failed",
      clientId: "in-flight",
      releaseId: "26.11.9",
      code: "probe_failed",
    });

    await deliver(mail.env);
    await deliver(mail.env);

    expect({
      mail: mail.sent.map(({ subject }) => subject),
      rows: await db.select().from(alerts),
    }).toStrictEqual({
      mail: [
        "in-flight: deploy of 26.11.9 failed",
        "in-flight deployed 26.11.10",
      ],
      rows: [],
    });
  });

  it("takes a redirect from Discord's webhook as a refusal, never following it", async () => {
    await withWebhook();
    await switchChannel("discord", true);
    discord.answer = () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.test/hook" },
      });
    await alert(db, {
      kind: "import_failed",
      releaseId: "26.11.11",
      code: "Error",
      attempt: 1,
    });

    await deliver();
    discord.answer = () => new Response(null, { status: 204 });
    await deliver();
    await deliver();

    expect({
      redirects: discord.redirects,
      tries: discord.posts.length,
    }).toStrictEqual({ redirects: ["manual", "manual"], tries: 2 });
  });

  it("carries a code's first line only, and at most 200 characters of it", async () => {
    await withWebhook();
    await switchChannel("discord", true);
    const long = "x".repeat(300);
    await alert(db, {
      kind: "deploy_failed",
      clientId: "long-code",
      releaseId: "26.11.12",
      code: `${long}\nupstream said more on its second line`,
    });

    await deliver();

    const [card] = discord.posts[0]?.embeds ?? [];
    expect(
      card?.fields.find(({ name }) => name === "Failure code")?.value
    ).toBe(`\`${"x".repeat(200)}\``);
  });

  it("tries a channel that refuses again at the next run, up to its attempts, while the other channel is told once", async () => {
    const mail = mailbox();
    await withWebhook();
    await switchChannel("mail", true);
    await switchChannel("discord", true);
    discord.answer = () => new Response("busy", { status: 500 });
    await alert(db, {
      kind: "import_failed",
      releaseId: "26.11.2",
      code: "Error",
      attempt: 1,
    });

    for (let run = 0; run < MAX_ATTEMPTS + 2; run += 1) {
      // oxlint-disable-next-line no-await-in-loop -- runs in order
      await deliver(mail.env);
    }

    expect({
      mail: mail.sent.length,
      discord: discord.posts.length,
    }).toStrictEqual({ mail: 1, discord: MAX_ATTEMPTS });
  });

  it("sends a change once when runs overlap, and leaves it to the next run while another delivers", async () => {
    const mail = mailbox();
    await switchChannel("mail", true);
    await alert(db, {
      kind: "import_failed",
      releaseId: "26.11.3",
      code: "Error",
      attempt: 1,
    });

    // Another run is delivering: this one leaves everything to it.
    await db.insert(leases).values({
      id: "alerts",
      holder: "another-run",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await deliver(mail.env);
    const whileHeld = mail.sent.length;
    await db.delete(leases).where(eq(leases.id, "alerts"));
    await Promise.all([deliver(mail.env), deliver(mail.env)]);

    expect({ whileHeld, after: mail.sent.length }).toStrictEqual({
      whileHeld: 0,
      after: 1,
    });
  });

  it("switches channels and sends test alerts, audited, saying plainly when a channel isn't set up", async () => {
    const tester = { email: "tester@grasp.test" };
    const states = async () => {
      const read = await callServerFn(fetchAlertChannelsFn, undefined, tester);
      return read.map(({ channel, on, ready }) => ({ channel, on, ready }));
    };
    const before = await states();
    // Off already: switching it off changes nothing, and audits nothing.
    await callServerFn(
      switchAlertChannelFn,
      { channel: "mail", on: false },
      tester
    );
    const unset = await callServerFn(
      sendTestAlertFn,
      { channel: "discord" },
      tester
    );
    await withWebhook();
    await callServerFn(
      switchAlertChannelFn,
      { channel: "discord", on: true },
      tester
    );
    // Switching it on again changes nothing, and audits nothing.
    await callServerFn(
      switchAlertChannelFn,
      { channel: "discord", on: true },
      tester
    );
    const sent = await callServerFn(
      sendTestAlertFn,
      { channel: "discord" },
      tester
    );
    const events = await db
      .select({
        action: auditEvents.action,
        actor: auditEvents.actor,
        target: auditEvents.target,
        detail: auditEvents.detail,
      })
      .from(auditEvents)
      .where(eq(auditEvents.actor, tester.email))
      .orderBy(sql`rowid`);

    expect({
      before,
      unset,
      sent,
      after: await states(),
      posts: titlesOf(discord.posts),
      events,
    }).toStrictEqual({
      before: [
        { channel: "mail", on: false, ready: false },
        { channel: "discord", on: false, ready: false },
      ],
      unset: "not_ready",
      sent: "sent",
      after: [
        { channel: "mail", on: false, ready: false },
        { channel: "discord", on: true, ready: true },
      ],
      posts: [
        [
          "Test: Deploy failed: Sample organization",
          "Test: Deploy recovered: Sample organization",
        ],
      ],
      events: [
        {
          action: "alerts.test",
          actor: tester.email,
          target: "discord",
          detail: JSON.stringify({ outcome: "not_ready" }),
        },
        {
          action: "alerts.on",
          actor: tester.email,
          target: "discord",
          detail: null,
        },
        {
          action: "alerts.test",
          actor: tester.email,
          target: "discord",
          detail: JSON.stringify({ outcome: "sent" }),
        },
      ],
    });
  });

  it("sends a test as a real alert looks, marked as a test, and records no alert or failure", async () => {
    const tester = { email: "sample-tester@grasp.test", sub: "sub-tester" };
    const mail = mailbox();
    await withWebhook();
    const hosted = { ...mail.env, ADMIN_HOST: "admin.grasp.test" };
    const outcomes = [
      await sendTestAlert(hosted, tester, "discord"),
      await sendTestAlert(hosted, tester, "mail"),
    ];
    // A real failure, delivered, for the cards to match.
    await switchChannel("discord", true);
    const clientId = await client();
    await alert(db, {
      kind: "deploy_failed",
      clientId,
      releaseId: "26.11.7",
      code: "release_rolled_back",
    });
    await deliver(hosted);
    const [test, real] = discord.posts;
    const [failure, recovery] = test?.embeds ?? [];
    const [sent] = mail.sent;
    const audited = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.actor, tester.email));

    expect({
      outcomes,
      cards: test?.embeds?.map(({ title, color, url, description }) => ({
        title,
        color,
        url,
        first: description.split("\n")[0],
      })),
      fields: failure?.fields.map(({ name, inline }) => ({ name, inline })),
      recoveryFields: recovery?.fields.map(({ name }) => name),
      mentions: test?.allowed_mentions,
      mail: { subject: sent?.subject, first: sent?.text?.split("\n")[0] },
      audited,
    }).toStrictEqual({
      outcomes: ["sent", "sent"],
      cards: [
        {
          title: "Test: Deploy failed: Sample organization",
          color: 0x99_aa_b5,
          url: "https://admin.grasp.test/platform/maintenance#alerts",
          first:
            "**A test, sent by hand from the admin: no organization is affected and nothing failed.**",
        },
        {
          title: "Test: Deploy recovered: Sample organization",
          color: 0x99_aa_b5,
          url: "https://admin.grasp.test/platform/maintenance?sample=recovery#alerts",
          first:
            "**A test, sent by hand from the admin: no organization is affected and nothing failed.**",
        },
      ],
      fields: real?.embeds?.[0]?.fields.map(({ name, inline }) => ({
        name,
        inline,
      })),
      recoveryFields: [
        "Organization",
        "Release",
        "Channel",
        "Failing for",
        "Stage",
      ],
      mentions: { parse: [] },
      mail: {
        subject:
          "Test: Sample organization (sample-organization): deploy of 26.11.7 failed",
        first:
          "A test from the admin, sent by hand: no organization is affected and nothing failed. A real alert reads like this:",
      },
      audited: [{ action: "alerts.test" }, { action: "alerts.test" }],
    });
    // Only the real failure is an alert.
    await expect(
      db.select({ key: alerts.key }).from(alerts)
    ).resolves.toStrictEqual([{ key: `deploy:${clientId}` }]);
  });

  it("says on the Maintenance page which channel is on, and that one on but not set up sends nothing", async () => {
    await switchChannel("discord", true);
    const html = await maintenancePage();
    const text = html.replaceAll(/<[^>]*>/gu, " ").replaceAll(/\s+/gu, " ");
    const part = text.slice(
      text.indexOf("Alerts"),
      text.indexOf("Shared secrets")
    );

    expect(part).toContain(
      "Mail Not set up. Onboard the sending domain in Cloudflare’s Email Sending"
    );
    expect(part).toContain(
      "Discord On, but not set up: nothing is sent. Add DISCORD_ALERTS_WEBHOOK to the stage’s 1Password Environment, then run Deploy platform."
    );
    expect(part).toContain("Send a test to Mail");
    expect(part).toContain("Send a test to Discord");
  });
});
