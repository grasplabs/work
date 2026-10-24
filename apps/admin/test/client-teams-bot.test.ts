/**
 * A client's Teams bot, set in the admin, and its app package. Written
 * from how it could go wrong first: one client's bot reaching another's
 * connect, a client without a bot stopped from deploying, a package Teams
 * refuses, or one that names anything but that client's bot, set by
 * someone who isn't staff, or changed without the audit log saying so.
 */
import { Validator } from "@cfworker/json-schema";
import { fromBase64Url } from "@grasp-os/shared/encoding";
import { env } from "cloudflare:workers";
import { and, asc, eq, sql } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  fetchClientSetup,
  fetchTeamsPackageFn,
  setTeamsBotFn,
} from "../src/clients/functions.ts";
import { setSealedSecret, setTeamsBot } from "../src/clients/settings.ts";
import { act, adminDatabase } from "../src/db/act.ts";
import { auditEvents, clients } from "../src/db/schema.ts";
import { deployContext } from "../src/deploy/context.ts";
import { runDeploy, startDeploy } from "../src/deploy/deploy.ts";
import { importReleases } from "../src/releases/import.ts";
import { targetClient } from "../src/rollout/targets.ts";
import { mockAccess } from "./access.ts";
import type { AccountState } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { callServerFn } from "./pages.ts";
import { publishRelease } from "./releases.ts";
import { useStoreSecrets } from "./secrets-store.ts";
import manifestSchema from "./teams-manifest-v1.19.schema.json" with { type: "json" };

const token = "test-deployer-token-teams-bot-5c2e19";
const tenantToken = "test-tenant-admin-token-teams-bot-a7d4f0";
const cloudflare = mockCloudflareApi(token, tenantToken);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = adminDatabase(env.DB);
const setup = { email: "setup@grasp.test", sub: "sub-setup" };
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/** A bot as Entra shows one: a fresh app id, in a fresh tenant. */
const newBot = () => ({
  appId: crypto.randomUUID(),
  tenantId: crypto.randomUUID(),
  secretExpiresOn: "2027-04-30",
});

/** An active client on a new account in the fake, running a new release as a deploy made it. */
const liveClient = async (name: string) => {
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
        name,
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
};

/** The version all of `script`'s traffic goes to in `account`. */
const liveVersionOf = (account: AccountState, script: string) => {
  const state = account.scripts.get(script);
  const [only] = state?.deployments[0]?.versions ?? [];
  return state?.versions.find(({ id }) => id === only?.version_id);
};

/** A binding of an upload's metadata, as far as these tests read it. */
const bindingSchema = z.object({
  name: z.string(),
  type: z.string(),
  json: z.unknown(),
});

/** The Teams bot's vars and secret on the live version of `script`, by name. */
const botOn = (account: AccountState, script: string) => {
  const version = liveVersionOf(account, script);
  const listed: unknown[] = z
    .array(z.unknown())
    .parse(version?.metadata.bindings ?? []);
  const vars = Object.fromEntries(
    listed.flatMap((binding) => {
      const parsed = bindingSchema.safeParse(binding);
      return parsed.success &&
        parsed.data.name.startsWith("TEAMS_BOT_") &&
        parsed.data.type === "json"
        ? [
            [
              parsed.data.name,
              { type: parsed.data.type, json: parsed.data.json },
            ],
          ]
        : [];
    })
  );
  return {
    vars,
    secret: version?.secrets.has("TEAMS_BOT_SECRET") ?? false,
  };
};

/** Client `clientId`'s audit events of its bot, oldest first. */
const botEventsOf = async (clientId: string) =>
  await db
    .select({ actor: auditEvents.actor, detail: auditEvents.detail })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.clientId, clientId),
        eq(auditEvents.action, "client.teams_bot")
      )
    )
    .orderBy(asc(auditEvents.at), asc(sql`rowid`));

/** Client `clientId`'s package, as staff download it, unzipped. */
const downloaded = async (clientId: string) => {
  const download = await callServerFn(
    fetchTeamsPackageFn,
    { clientId },
    { email: staff.email }
  );
  if (download === null) {
    return null;
  }
  const files = unzipSync(fromBase64Url(download.zip));
  return {
    fileName: download.fileName,
    names: Object.keys(files).toSorted(),
    manifestText: strFromU8(files["manifest.json"] ?? new Uint8Array()),
    color: files["color.png"] ?? new Uint8Array(),
    outline: files["outline.png"] ?? new Uint8Array(),
  };
};

/** A PNG's width, height, bit depth and colour type, from its header. */
const pngHeader = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    signature: [...bytes.subarray(0, 8)],
    width: view.getUint32(16),
    height: view.getUint32(20),
    depth: bytes[24],
    colourType: bytes[25],
  };
};
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("a client's Teams bot", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });
  // An earlier test's clients are gone from the fake: offboarded, so
  // nothing reads their accounts.
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.status, "active"));
  });

  it("reaches the client's own connect and core at its next deploy, and no other client's; one without a bot deploys without one", async () => {
    const acme = await liveClient("Acme Logistics");
    const other = await liveClient("Other Company");
    const bot = newBot();

    await setTeamsBot(env, staff, { clientId: acme.clientId, bot });
    await setSealedSecret(env, staff, {
      clientId: acme.clientId,
      name: "TEAMS_BOT_SECRET",
      value: `Bq8~${crypto.randomUUID().replaceAll("-", "")}`,
    });
    // A rollout deploys it next, even on the release it runs.
    const pending = await targetClient(db, acme.clientId);
    await redeploy(acme.clientId, acme.releaseId);
    await redeploy(other.clientId, other.releaseId);

    expect({
      pending: pending?.configPending,
      connect: botOn(acme.account, "grasp-os-connect"),
      core: botOn(acme.account, "grasp-os-core"),
      other: [
        botOn(other.account, "grasp-os-connect"),
        botOn(other.account, "grasp-os-core"),
      ],
    }).toStrictEqual({
      pending: true,
      connect: {
        vars: {
          TEAMS_BOT_ID: { type: "json", json: bot.appId },
          TEAMS_BOT_TENANT_ID: { type: "json", json: bot.tenantId },
        },
        secret: true,
      },
      // Core checks what Teams sends is for its bot; it never sends as it.
      core: {
        vars: { TEAMS_BOT_ID: { type: "json", json: bot.appId } },
        secret: false,
      },
      other: [
        { vars: {}, secret: false },
        { vars: {}, secret: false },
      ],
    });
  });

  it("leaves the client's Workers at the deploy after it's taken away", async () => {
    const acme = await liveClient("Acme Logistics");
    await setTeamsBot(env, staff, { clientId: acme.clientId, bot: newBot() });
    await redeploy(acme.clientId, acme.releaseId);
    const removed = await setTeamsBot(env, staff, {
      clientId: acme.clientId,
      bot: null,
    });
    await redeploy(acme.clientId, acme.releaseId);

    expect({
      removed,
      connect: botOn(acme.account, "grasp-os-connect").vars,
      core: botOn(acme.account, "grasp-os-core").vars,
      download: await downloaded(acme.clientId),
    }).toStrictEqual({ removed: true, connect: {}, core: {}, download: null });
  });

  it("makes a package Microsoft's v1.19 schema takes, naming that client's bot and name and nothing else", async () => {
    const acme = await liveClient("Acme Logistics");
    const other = await liveClient("Other Company");
    const bot = newBot();
    const otherBot = newBot();
    await setTeamsBot(env, staff, { clientId: acme.clientId, bot });
    await setTeamsBot(env, staff, { clientId: other.clientId, bot: otherBot });

    const download = await downloaded(acme.clientId);
    const manifestText = download?.manifestText ?? "";
    const manifest: unknown = JSON.parse(manifestText);
    const validation = new Validator(
      z.record(z.string(), z.unknown()).parse(manifestSchema),
      "4"
    ).validate(manifest);
    // Every GUID it names, wherever in it.
    const guids = new Set(
      manifestText.match(
        /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/giu
      )
    );

    expect({
      fileName: download?.fileName,
      files: download?.names,
      errors: validation.errors,
      manifest,
      guids: [...guids],
      othersNamed: [
        other.clientId,
        "Other Company",
        otherBot.appId,
        otherBot.tenantId,
      ].filter((text) => manifestText.includes(text)),
      // Its tenant is the client's Entra's: Teams needs none of it.
      tenantNamed: manifestText.includes(bot.tenantId),
      icons: {
        color: pngHeader(download?.color ?? new Uint8Array(32)),
        outline: pngHeader(download?.outline ?? new Uint8Array(32)),
      },
    }).toMatchObject({
      fileName: `stephen-teams-${acme.clientId}.zip`,
      files: ["color.png", "manifest.json", "outline.png"],
      errors: [],
      manifest: {
        manifestVersion: "1.19",
        id: bot.appId,
        name: { short: "Stephen", full: "Stephen for Acme Logistics" },
        icons: { color: "color.png", outline: "outline.png" },
        // Private chats alone: he answers one person at a time.
        bots: [{ botId: bot.appId, scopes: ["personal"] }],
      },
      guids: [bot.appId],
      othersNamed: [],
      tenantNamed: false,
      // Truecolour with alpha, at the sizes Teams asks for.
      icons: {
        color: {
          signature: pngSignature,
          width: 192,
          height: 192,
          depth: 8,
          colourType: 6,
        },
        outline: {
          signature: pngSignature,
          width: 32,
          height: 32,
          depth: 8,
          colourType: 6,
        },
      },
    });
  });

  it("is the same file for the same bot each time, and none for a client without one", async () => {
    const acme = await liveClient("Acme Logistics");
    const without = await liveClient("No Bot Yet");
    await setTeamsBot(env, staff, { clientId: acme.clientId, bot: newBot() });

    const first = await callServerFn(
      fetchTeamsPackageFn,
      { clientId: acme.clientId },
      { email: staff.email }
    );
    const second = await callServerFn(
      fetchTeamsPackageFn,
      { clientId: acme.clientId },
      { email: staff.email }
    );

    expect({
      same: first !== null && first.zip === second?.zip,
      without: await downloaded(without.clientId),
    }).toStrictEqual({ same: true, without: null });
  });

  it("is set only by staff Access vouches for, refused when it isn't a bot, and audited only when it changes", async () => {
    const acme = await liveClient("Acme Logistics");
    const bot = newBot();
    const change = { clientId: acme.clientId, bot };

    await expect(
      callServerFn(setTeamsBotFn, change, { email: null })
    ).rejects.toThrow("The server function answered 403");
    await expect(
      callServerFn(setTeamsBotFn, change, {
        email: staff.email,
        from: "https://elsewhere.test",
      })
    ).rejects.toThrow("The server function answered 403");
    await expect(
      callServerFn(
        fetchTeamsPackageFn,
        { clientId: acme.clientId },
        {
          email: null,
        }
      )
    ).rejects.toThrow("The server function answered 403");
    const answers = [
      ...(await Promise.all(
        [
          { ...bot, appId: "not-a-guid" },
          { ...bot, tenantId: "contoso.onmicrosoft.com" },
          { ...bot, secretExpiresOn: "next year" },
          { appId: bot.appId, tenantId: bot.tenantId },
        ].map(
          async (invalid) =>
            await callServerFn(
              setTeamsBotFn,
              { clientId: acme.clientId, bot: invalid },
              { email: staff.email }
            )
        )
      )),
      await callServerFn(setTeamsBotFn, change, { email: staff.email }),
      // The same bot again changes nothing, whatever order its fields are in.
      await callServerFn(
        setTeamsBotFn,
        {
          clientId: acme.clientId,
          bot: {
            secretExpiresOn: bot.secretExpiresOn,
            tenantId: bot.tenantId,
            appId: bot.appId,
          },
        },
        { email: setup.email }
      ),
    ];
    const read = await callServerFn(
      fetchClientSetup,
      { clientId: acme.clientId },
      { email: staff.email }
    );

    expect({
      answers,
      events: await botEventsOf(acme.clientId),
      shown: read?.teamsBot,
    }).toStrictEqual({
      answers: [
        { changed: null, refused: "teams_bot_invalid" },
        { changed: null, refused: "teams_bot_invalid" },
        { changed: null, refused: "teams_bot_invalid" },
        { changed: null, refused: "teams_bot_invalid" },
        { changed: true, refused: null },
        { changed: false, refused: null },
      ],
      events: [{ actor: staff.email, detail: JSON.stringify(bot) }],
      shown: bot,
    });
  });
});
