import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { alert, deliverAlerts, MAX_ATTEMPTS } from "../src/alerts/alert.ts";
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
  content: string;
  allowed_mentions: unknown;
}

/** What Discord was sent, and how it answers: 204 unless a test says otherwise. */
const discord: { posts: DiscordPost[]; answer: () => Response } = {
  posts: [],
  answer: () => new Response(null, { status: 204 }),
};

/** The alert mail's binding as a deploy binds it, keeping each message it was given. */
const mailbox = () => {
  const sent: EmailMessageBuilder[] = [];
  const binding: SendEmail = {
    send: async (message: EmailMessage | EmailMessageBuilder) => {
      // Taken a moment later, as Email Sending takes a message.
      await Promise.resolve();
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
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== webhook) {
        throw new Error(`Unexpected outbound request to ${request.url}`);
      }
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
      discord: discord.posts.map(({ content }) => content.split("\n")[0]),
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
        `**Release ${release.id} didn't import**`,
        `**Release ${release.id} imported**`,
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

    expect(discord.posts).toStrictEqual([
      {
        content: `**${clientId} (${clientId}): deploy of 26.11.7 failed**\nThe deploy of release 26.11.7 to ${clientId} (${clientId}) failed (release_rolled_back). Retry it on its Setup once what stopped it is fixed.\nhttps://admin.grasp.test/organizations/${clientId}/setup`,
        allowed_mentions: { parse: [] },
      },
      {
        content: `**${clientId} (${clientId}) deployed 26.11.8**\n${clientId} (${clientId}) runs release 26.11.8 now, after a failed deploy.\nhttps://admin.grasp.test/organizations/${clientId}/setup`,
        allowed_mentions: { parse: [] },
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

    expect({
      before,
      after: discord.posts.map(({ content }) => content.split("\n")[0]),
    }).toStrictEqual({
      before: 0,
      after: ["**Release 26.11.4 didn't import**"],
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
      posts: discord.posts.map(({ content }) => content.split("\n")[0]),
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
      posts: ["**Test alert**"],
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
