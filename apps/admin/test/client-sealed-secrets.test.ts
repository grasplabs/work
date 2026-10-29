/**
 * A client's Teams bot secret and Slack app secrets, sealed in the admin.
 * Written from how they could leak or land in the wrong place first:
 * shown back on a page or in what a page is sent, logged, kept or audited
 * in the clear, set by someone who isn't staff, given to another client's
 * Worker or to the wrong one of its own, pasted into the wrong field, or
 * deployed without the one staff set.
 */
import { env, exports } from "cloudflare:workers";
import { and, asc, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  fetchClientSetup,
  setSealedSecretFn,
} from "../src/clients/functions.ts";
import { SettingsError, setSealedSecret } from "../src/clients/settings.ts";
import { slackAppManifest } from "../src/clients/slack-app.ts";
import { adminDatabase } from "../src/db/act.ts";
import {
  auditEvents,
  clientProvisions,
  clients,
  clientSealedSecrets,
} from "../src/db/schema.ts";
import { targetClient } from "../src/rollout/targets.ts";
import { accessJwt, mockAccess } from "./access.ts";
import type { AccountState } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { callServerFn } from "./pages.ts";
import {
  deployPlaced,
  livePlacedClient,
  placedRelease,
  scriptsOf,
} from "./placed.ts";
import { emptyStoreSecret, useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-sealed-4f81c2";
const cloudflare = mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = adminDatabase(env.DB);
const setup = { email: "setup@grasp.test", sub: "sub-setup" };
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/** A client secret as Entra mints one: 40 characters. */
const botSecret = (): string =>
  `Bq8~${crypto.randomUUID().replaceAll("-", "")}.x_4`;

/** A Slack bot token as Slack mints one. */
const slackToken = (): string =>
  `xoxb-${String(Date.now()).slice(-12)}-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;

/** A Slack app's signing secret: 32 hex characters. */
const signingSecret = (): string => crypto.randomUUID().replaceAll("-", "");

/** A live placed client in a destination of its own, running a new release as its operation made it. */
const liveClient = async () => {
  const release = await placedRelease("feat(connect): its bot");
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const { account } = await livePlacedClient(cloudflare, 1, release, {
    id: clientId,
    name: clientId,
    signIn: null,
  });
  return {
    clientId,
    account,
    releaseId: release,
    scripts: await scriptsOf(clientId),
  };
};

/** Runs client `clientId`'s release again, as applying its settings does. */
const redeploy = async (clientId: string, releaseId: string) => {
  await deployPlaced(clientId, releaseId);
};

/** A live client's account and its scripts there. */
interface LiveClient {
  account: AccountState;
  scripts: { core: string; connect: string };
}

/** The secrets of the version all of `worker`'s traffic goes to, for `client`. */
const liveSecretsOf = (
  { account, scripts }: LiveClient,
  worker: "core" | "connect"
) => {
  const state = account.scripts.get(scripts[worker]);
  const [only] = state?.deployments[0]?.versions ?? [];
  const live = state?.versions.find(({ id }) => id === only?.version_id);
  return live?.secrets ?? new Map<string, string>();
};

/** Client `clientId`'s audit events of its sealed secrets, oldest first. */
const sealedEventsOf = async (clientId: string) =>
  await db
    .select({
      actor: auditEvents.actor,
      target: auditEvents.target,
      detail: auditEvents.detail,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.clientId, clientId),
        eq(auditEvents.action, "client.sealed_secret")
      )
    )
    .orderBy(asc(auditEvents.at), asc(sql`rowid`));

/** Client `clientId`'s sealed rows, as D1 holds them. */
const sealedRowsOf = async (clientId: string) =>
  await db
    .select()
    .from(clientSealedSecrets)
    .where(eq(clientSealedSecrets.clientId, clientId));

/** What `task` was refused with, or `done`. */
const codeOf = async (task: Promise<unknown>): Promise<string> => {
  try {
    await task;
    return "done";
  } catch (error) {
    return error instanceof SettingsError ? error.code : "other";
  }
};

/** Everything `task` writes to the console while it runs, as text. */
const loggedBy = async (task: () => Promise<unknown>): Promise<string> => {
  const lines: unknown[] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map(
    (level) =>
      vi.spyOn(console, level).mockImplementation((...args) => {
        lines.push(args);
      })
  );
  try {
    await task();
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
  return JSON.stringify(lines);
};

/** The page at `path` as a staff member's browser gets it: its scripts and the data sent along with them included. */
const rawPage = async (path: string): Promise<string> => {
  const response = await exports.default.fetch(
    `https://ops.grasp.test${path}`,
    {
      headers: { "cf-access-jwt-assertion": await accessJwt(staff.email) },
    }
  );
  return await response.text();
};

describe("a client's Teams bot secret", () => {
  useStoreSecrets({ deployer: token });
  // An earlier test's clients are gone from the fake: offboarded, so
  // nothing reads their accounts.
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.status, "active"));
  });

  it("reaches the client's own connect at its next deploy and no other client's, and a replacement reaches it at the deploy after", async () => {
    const acme = await liveClient();
    const other = await liveClient();
    const first = botSecret();
    const second = botSecret();

    await setSealedSecret(env, staff, {
      clientId: acme.clientId,
      name: "TEAMS_BOT_SECRET",
      value: first,
    });
    // A rollout deploys it next, even on the release it runs.
    const pending = await targetClient(db, acme.clientId);
    await redeploy(acme.clientId, acme.releaseId);
    await redeploy(other.clientId, other.releaseId);
    const deployed = {
      connect: liveSecretsOf(acme, "connect").get("TEAMS_BOT_SECRET"),
      core: liveSecretsOf(acme, "core").has("TEAMS_BOT_SECRET"),
      other: liveSecretsOf(other, "connect").has("TEAMS_BOT_SECRET"),
    };
    await setSealedSecret(env, staff, {
      clientId: acme.clientId,
      name: "TEAMS_BOT_SECRET",
      value: second,
    });
    const before = liveSecretsOf(acme, "connect").get("TEAMS_BOT_SECRET");
    await redeploy(acme.clientId, acme.releaseId);

    expect({
      pending: pending?.configPending,
      deployed,
      // A replacement waits for the next deploy, then is the only one.
      before,
      after: liveSecretsOf(acme, "connect").get("TEAMS_BOT_SECRET"),
    }).toStrictEqual({
      pending: true,
      deployed: { connect: first, core: false, other: false },
      before: first,
      after: second,
    });
  });

  // Slower than the default: it renders five of the admin's pages on the server.
  it("is never kept, logged, audited, shown on a page or sent to the browser", async () => {
    const acme = await liveClient();
    const value = botSecret();

    const logged = await loggedBy(async () => {
      await setSealedSecret(env, staff, {
        clientId: acme.clientId,
        name: "TEAMS_BOT_SECRET",
        value,
      });
      await redeploy(acme.clientId, acme.releaseId);
    });
    const [row] = await sealedRowsOf(acme.clientId);
    const sealed = row?.sealed ?? "";
    const events = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.clientId, acme.clientId));
    const operations = await db
      .select()
      .from(clientProvisions)
      .where(eq(clientProvisions.clientId, acme.clientId));
    const base = `/organizations/${acme.clientId}/setup`;
    const pages = [
      await rawPage(base),
      await rawPage(`${base}?tab=settings`),
      await rawPage(`${base}?tab=history`),
      await rawPage(`/organizations/${acme.clientId}/log`),
      await rawPage("/platform"),
    ].join("\n");
    const read = JSON.stringify(
      await callServerFn(
        fetchClientSetup,
        { clientId: acme.clientId },
        { email: staff.email }
      )
    );
    const kept = JSON.stringify([events, operations]);

    expect({
      // It reached connect, so everything below had the chance to leak it.
      deployed:
        liveSecretsOf(acme, "connect").get("TEAMS_BOT_SECRET") === value,
      sealedInTheClear: sealed.includes(value),
      // The settings show who set it and when, and nothing else of it.
      shown: pages.includes(`by ${staff.email}`),
      leaks: [logged, kept, pages, read].map(
        (text) => text.includes(value) || text.includes(sealed)
      ),
    }).toStrictEqual({
      deployed: true,
      sealedInTheClear: false,
      shown: true,
      leaks: [false, false, false, false],
    });
  }, 90_000);

  it("is set only by staff Access vouches for, from the admin's own pages, and is audited each time as them", async () => {
    const acme = await liveClient();
    const change = {
      clientId: acme.clientId,
      name: "TEAMS_BOT_SECRET" as const,
      value: botSecret(),
    };

    await expect(
      callServerFn(setSealedSecretFn, change, { email: null })
    ).rejects.toThrow("The server function answered 403");
    await expect(
      callServerFn(setSealedSecretFn, change, {
        email: staff.email,
        from: "https://elsewhere.test",
      })
    ).rejects.toThrow("The server function answered 403");
    const refused = await sealedRowsOf(acme.clientId);
    const answers = [
      await callServerFn(setSealedSecretFn, change, { email: staff.email }),
      await callServerFn(
        setSealedSecretFn,
        { ...change, value: botSecret() },
        { email: setup.email }
      ),
    ];

    expect({
      refused,
      answers,
      events: await sealedEventsOf(acme.clientId),
    }).toStrictEqual({
      refused: [],
      // Whether it changed, never the value.
      answers: [
        { changed: true, refused: null },
        { changed: true, refused: null },
      ],
      events: [
        {
          actor: staff.email,
          target: "TEAMS_BOT_SECRET",
          detail: JSON.stringify({ replaced: false }),
        },
        {
          actor: setup.email,
          target: "TEAMS_BOT_SECRET",
          detail: JSON.stringify({ replaced: true }),
        },
      ],
    });
  });

  it("audits only one of two first sets made together as the first, and the other as replacing it", async () => {
    const acme = await liveClient();
    const set = async (by: typeof staff, value: string) =>
      await setSealedSecret(env, by, {
        clientId: acme.clientId,
        name: "TEAMS_BOT_SECRET",
        value,
      });

    await Promise.all([set(staff, botSecret()), set(setup, botSecret())]);

    const events = await sealedEventsOf(acme.clientId);
    const rows = await sealedRowsOf(acme.clientId);
    expect({
      details: events.map(({ detail }) => detail),
      rows: rows.length,
    }).toStrictEqual({
      details: [
        JSON.stringify({ replaced: false }),
        JSON.stringify({ replaced: true }),
      ],
      rows: 1,
    });
  });

  it("refuses what isn't a secret, a client the admin doesn't have, and a store without CLIENT_KEY, keeping nothing and answering no value back", async () => {
    const acme = await liveClient();
    const spaced = `${botSecret()} ${botSecret()}`;

    const answer = await callServerFn(
      setSealedSecretFn,
      { clientId: acme.clientId, name: "TEAMS_BOT_SECRET", value: spaced },
      { email: staff.email }
    );
    const codes = [
      await codeOf(
        setSealedSecret(env, staff, {
          clientId: acme.clientId,
          name: "TEAMS_BOT_SECRET",
          value: "",
        })
      ),
      await codeOf(
        setSealedSecret(env, staff, {
          clientId: acme.clientId,
          name: "TEAMS_BOT_SECRET",
          value: 42,
        })
      ),
      await codeOf(
        setSealedSecret(env, staff, {
          clientId: "no-such-client",
          name: "TEAMS_BOT_SECRET",
          value: botSecret(),
        })
      ),
    ];
    await emptyStoreSecret(env.CLIENT_KEY, "CLIENT_KEY");
    const withoutKey = await codeOf(
      setSealedSecret(env, staff, {
        clientId: acme.clientId,
        name: "TEAMS_BOT_SECRET",
        value: botSecret(),
      })
    );

    expect({
      answer,
      answered: JSON.stringify(answer).includes(spaced),
      codes,
      withoutKey,
      rows: await sealedRowsOf(acme.clientId),
      events: await sealedEventsOf(acme.clientId),
    }).toStrictEqual({
      answer: { changed: null, refused: "secret_invalid" },
      answered: false,
      codes: ["secret_invalid", "secret_invalid", "unknown_client"],
      withoutKey: "store_secret_missing",
      rows: [],
      events: [],
    });
  });

  it("doesn't open for another client: a sealed value moved to its row stops its deploy before its connect changes", async () => {
    const acme = await liveClient();
    const other = await liveClient();
    await setSealedSecret(env, staff, {
      clientId: acme.clientId,
      name: "TEAMS_BOT_SECRET",
      value: botSecret(),
    });
    const [row] = await sealedRowsOf(acme.clientId);
    await db.insert(clientSealedSecrets).values({
      clientId: other.clientId,
      name: "TEAMS_BOT_SECRET",
      sealed: row?.sealed ?? "",
      setBy: staff.email,
      setAt: new Date(),
    });
    const versions = other.account.scripts.get(other.scripts.connect)?.versions
      .length;

    const logged = await loggedBy(async () => {
      await expect(
        deployPlaced(other.clientId, other.releaseId)
      ).rejects.toMatchObject({ code: "sealed_secret_unreadable" });
    });
    const [deploy] = await db
      .select({
        status: clientProvisions.status,
        error: clientProvisions.error,
      })
      .from(clientProvisions)
      .where(eq(clientProvisions.clientId, other.clientId));

    expect({
      deploy,
      versions: other.account.scripts.get(other.scripts.connect)?.versions
        .length,
      connect: liveSecretsOf(other, "connect").has("TEAMS_BOT_SECRET"),
      logged: logged.includes(row?.sealed ?? "-"),
    }).toStrictEqual({
      deploy: { status: "failed", error: "sealed_secret_unreadable" },
      versions,
      connect: false,
      logged: false,
    });
  });
});

describe("a client's Slack app", () => {
  useStoreSecrets({ deployer: token });
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.status, "active"));
  });

  it("gives its bot token only to its own connect and its signing secret only to its own core, at its next deploy", async () => {
    const acme = await liveClient();
    const other = await liveClient();
    const bot = slackToken();
    const signing = signingSecret();

    await setSealedSecret(env, staff, {
      clientId: acme.clientId,
      name: "SLACK_BOT_TOKEN",
      value: bot,
    });
    await setSealedSecret(env, staff, {
      clientId: acme.clientId,
      name: "SLACK_SIGNING_SECRET",
      value: signing,
    });
    await redeploy(acme.clientId, acme.releaseId);
    await redeploy(other.clientId, other.releaseId);
    const events = await sealedEventsOf(acme.clientId);
    const slackOn = (client: LiveClient, worker: "core" | "connect") => {
      const secrets = liveSecretsOf(client, worker);
      return {
        token: secrets.get("SLACK_BOT_TOKEN") ?? null,
        signing: secrets.get("SLACK_SIGNING_SECRET") ?? null,
      };
    };

    expect({
      connect: slackOn(acme, "connect"),
      core: slackOn(acme, "core"),
      otherConnect: slackOn(other, "connect"),
      otherCore: slackOn(other, "core"),
      events: events.map(({ target }) => target),
    }).toStrictEqual({
      connect: { token: bot, signing: null },
      core: { token: null, signing },
      otherConnect: { token: null, signing: null },
      otherCore: { token: null, signing: null },
      events: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
    });
  });

  it("refuses a value pasted into the wrong field, or a token that acts as more than the bot, keeping nothing", async () => {
    const acme = await liveClient();
    const userToken = slackToken().replace("xoxb-", "xoxp-");
    const appToken = slackToken().replace("xoxb-", "xapp-");
    const tries = [
      ["SLACK_BOT_TOKEN", userToken],
      ["SLACK_BOT_TOKEN", appToken],
      ["SLACK_BOT_TOKEN", signingSecret()],
      ["SLACK_BOT_TOKEN", botSecret()],
      ["SLACK_SIGNING_SECRET", slackToken()],
      ["SLACK_SIGNING_SECRET", botSecret()],
      ["SLACK_SIGNING_SECRET", signingSecret().toUpperCase()],
    ] as const;

    const codes = await Promise.all(
      tries.map(
        async ([name, value]) =>
          await codeOf(
            setSealedSecret(env, staff, {
              clientId: acme.clientId,
              name,
              value,
            })
          )
      )
    );

    expect({
      codes,
      rows: await sealedRowsOf(acme.clientId),
      events: await sealedEventsOf(acme.clientId),
    }).toStrictEqual({
      codes: tries.map(() => "secret_invalid"),
      rows: [],
      events: [],
    });
  });

  it("is set up on its settings page from a manifest that sends to its own core, without showing a secret set there", async () => {
    const acme = await liveClient();
    const bot = slackToken();
    await setSealedSecret(env, staff, {
      clientId: acme.clientId,
      name: "SLACK_BOT_TOKEN",
      value: bot,
    });

    const page = await rawPage(
      `/organizations/${acme.clientId}/setup?tab=settings`
    );

    expect({
      requestUrl: page.includes(
        `https://${acme.clientId}.grasp.test/api/channels/slack`
      ),
      shown: page.includes("Bot token"),
      leaked: page.includes(bot),
    }).toStrictEqual({ requestUrl: true, shown: true, leaked: false });
  }, 60_000);

  it("asks Slack only for what connect lets core send and the door reads, in direct messages", () => {
    const manifest = slackAppManifest("acme.grasp.test", "Acme");

    expect({
      name: manifest.display_information.name,
      scopes: manifest.oauth_config.scopes,
      events: manifest.settings.event_subscriptions,
      interactivity: manifest.settings.interactivity,
    }).toStrictEqual({
      name: "Stephen for Acme",
      // No user scopes, channel history, files or admin.
      scopes: { bot: ["chat:write", "im:history", "im:read", "users:read"] },
      events: {
        request_url: "https://acme.grasp.test/api/channels/slack",
        bot_events: ["message.im"],
      },
      interactivity: {
        is_enabled: true,
        request_url: "https://acme.grasp.test/api/channels/slack",
      },
    });
  });
});
