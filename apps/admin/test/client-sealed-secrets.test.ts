/**
 * A client's Teams bot secret, sealed in the admin. Written from how it
 * could leak or land in the wrong place first: shown back on a page or in
 * what a page is sent, logged, kept or audited in the clear, set by
 * someone who isn't staff, given to another client's connect, or deployed
 * without the one staff set.
 */
import { env, exports } from "cloudflare:workers";
import { and, asc, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  fetchClientSetup,
  setSealedSecretFn,
} from "../src/clients/functions.ts";
import { SettingsError, setSealedSecret } from "../src/clients/settings.ts";
import { act, adminDatabase } from "../src/db/act.ts";
import {
  auditEvents,
  clientDeploys,
  clients,
  clientSealedSecrets,
} from "../src/db/schema.ts";
import { deployContext } from "../src/deploy/context.ts";
import { runDeploy, startDeploy } from "../src/deploy/deploy.ts";
import { importReleases } from "../src/releases/import.ts";
import { targetClient } from "../src/rollout/targets.ts";
import { accessJwt, mockAccess } from "./access.ts";
import type { AccountState } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { callServerFn } from "./pages.ts";
import { publishRelease } from "./releases.ts";
import { emptyStoreSecret, useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-sealed-4f81c2";
const tenantToken = "test-tenant-admin-token-sealed-93b0d7";
const cloudflare = mockCloudflareApi(token, tenantToken);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = adminDatabase(env.DB);
const setup = { email: "setup@grasp.test", sub: "sub-setup" };
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/** A client secret as Entra mints one: 40 characters. */
const botSecret = (): string =>
  `Bq8~${crypto.randomUUID().replaceAll("-", "")}.x_4`;

/** An active client on a new account in the fake, running a new release as a deploy made it. */
const liveClient = async () => {
  const release = await publishRelease({ notes: "feat(connect): its bot" });
  await importReleases(env.RELEASES, db);
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const account = cloudflare.addAccount();
  const now = new Date();
  await act(
    db,
    setup,
    [
      db.insert(clients).values({
        id: clientId,
        name: clientId,
        accountId: account.id,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  await runDeploy(
    await deployContext(env),
    await startDeploy(db, setup, clientId, release.id)
  );
  return { clientId, account, releaseId: release.id };
};

/** Deploys client `clientId`'s release again, as applying its settings does. */
const redeploy = async (clientId: string, releaseId: string) => {
  const deployId = await startDeploy(
    db,
    setup,
    clientId,
    releaseId,
    "settings"
  );
  await runDeploy(await deployContext(env), deployId);
  return deployId;
};

/** The secrets of the version all of `script`'s traffic goes to in `account`. */
const liveSecretsOf = (account: AccountState, script: string) => {
  const state = account.scripts.get(script);
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
  useStoreSecrets({ deployer: token, tenant: tenantToken });
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
      connect: liveSecretsOf(acme.account, "grasp-os-connect").get(
        "TEAMS_BOT_SECRET"
      ),
      core: liveSecretsOf(acme.account, "grasp-os-core").has(
        "TEAMS_BOT_SECRET"
      ),
      other: liveSecretsOf(other.account, "grasp-os-connect").has(
        "TEAMS_BOT_SECRET"
      ),
    };
    await setSealedSecret(env, staff, {
      clientId: acme.clientId,
      name: "TEAMS_BOT_SECRET",
      value: second,
    });
    const before = liveSecretsOf(acme.account, "grasp-os-connect").get(
      "TEAMS_BOT_SECRET"
    );
    await redeploy(acme.clientId, acme.releaseId);

    expect({
      pending: pending?.configPending,
      deployed,
      // A replacement waits for the next deploy, then is the only one.
      before,
      after: liveSecretsOf(acme.account, "grasp-os-connect").get(
        "TEAMS_BOT_SECRET"
      ),
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
    const deploys = await db
      .select()
      .from(clientDeploys)
      .where(eq(clientDeploys.clientId, acme.clientId));
    const base = `/organizations/${acme.clientId}/setup`;
    const pages = [
      await rawPage(base),
      await rawPage(`${base}?tab=settings`),
      await rawPage(`${base}?tab=deploys`),
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
    const kept = JSON.stringify([events, deploys]);

    expect({
      // It reached connect, so everything below had the chance to leak it.
      deployed:
        liveSecretsOf(acme.account, "grasp-os-connect").get(
          "TEAMS_BOT_SECRET"
        ) === value,
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
    const versions =
      other.account.scripts.get("grasp-os-connect")?.versions.length;

    const deployId = await startDeploy(
      db,
      setup,
      other.clientId,
      other.releaseId,
      "settings"
    );
    const logged = await loggedBy(async () => {
      await expect(
        runDeploy(await deployContext(env), deployId)
      ).rejects.toMatchObject({ code: "sealed_secret_unreadable" });
    });
    const [deploy] = await db
      .select({ status: clientDeploys.status, error: clientDeploys.error })
      .from(clientDeploys)
      .where(eq(clientDeploys.id, deployId));

    expect({
      deploy,
      versions: other.account.scripts.get("grasp-os-connect")?.versions.length,
      connect: liveSecretsOf(other.account, "grasp-os-connect").has(
        "TEAMS_BOT_SECRET"
      ),
      logged: logged.includes(row?.sealed ?? "-"),
    }).toStrictEqual({
      deploy: { status: "failed", error: "sealed_secret_unreadable" },
      versions,
      connect: false,
      logged: false,
    });
  });
});
