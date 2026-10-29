import { env } from "cloudflare:workers";
import { and, eq, isNull, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  platformTransports,
  setPlatformModelTransport,
} from "../src/admin/platform-ai.ts";
import { clientModelTransport } from "../src/clients/model-transport.ts";
import { setModelTransport } from "../src/clients/settings.ts";
import { adminDatabase } from "../src/db/act.ts";
import {
  auditEvents,
  clients,
  platformSettings,
  settings,
} from "../src/db/schema.ts";
import { mockAccess } from "./access.ts";
import type { AccountState } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { page } from "./pages.ts";
import { deployPlaced, livePlacedClient, placedRelease } from "./placed.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// How a client's core reaches its models, from the admin: the provider
// keys a deploy gives it (only those its own transport names, from the
// store's), what staff set, and where its Setup says its AI runs, from
// what its core reports.

const token = "test-deployer-token-transport-4b8e17";
const cloudflare = mockCloudflareApi(token);
mockAccess();

const db = adminDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/** The secret `name` client core's live version holds, as JSON; undefined without it. */
const coreSecret = (account: AccountState, name: string): unknown => {
  const core = [...account.scripts.entries()].find(([script]) =>
    script.endsWith("-core")
  )?.[1];
  const value = core?.versions.at(-1)?.secrets.get(name);
  return value === undefined ? undefined : JSON.parse(value);
};

/** The part of a page titled `title`: from its label to its end. */
const sectionOf = (html: string, title: string): string => {
  const at = html.indexOf(`aria-label="${title}"`);
  return at === -1 ? "" : html.slice(at, html.indexOf("</section>", at));
};

/** `html` without its tags, so words split by markup read as one line. */
const textOf = (html: string): string =>
  html.replaceAll(/<[^>]+>/gu, "").replaceAll("&#x27;", "'");

/** Sets client `clientId`'s `MODEL_TRANSPORT` as stored. */
const storeTransport = async (
  clientId: string,
  transport: unknown
): Promise<void> => {
  const value = JSON.stringify(transport);
  await db
    .insert(settings)
    .values({
      clientId,
      key: "MODEL_TRANSPORT",
      value,
      updatedBy: staff.email,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [settings.clientId, settings.key],
      set: { value, updatedAt: new Date() },
    });
};

describe("a client's provider keys", () => {
  useStoreSecrets({ deployer: token });
  let release = "";
  beforeEach(async () => {
    release = await placedRelease("feat(core): model transports");
  });

  it("gives its core only the keys its own transport names, never the whole store's, and none once it names none", async () => {
    const { clientId, account } = await livePlacedClient(
      cloudflare,
      1,
      release
    );
    const builtIn = coreSecret(account, "MODEL_PROVIDER_KEYS");
    await storeTransport(clientId, {
      primary: { kind: "direct", "bedrock-eu": { key: "bedrock-eu" } },
      failover: [
        { kind: "openrouter", key: "openrouter" },
        // Named, but not in the store: left out, for core to say so.
        { kind: "direct", anthropic: { key: "acme-anthropic" } },
      ],
    });
    await deployPlaced(clientId, release);
    const named = coreSecret(account, "MODEL_PROVIDER_KEYS");
    await storeTransport(clientId, {
      primary: { kind: "cloudflare-ai-gateway" },
    });
    await deployPlaced(clientId, release);
    const none = coreSecret(account, "MODEL_PROVIDER_KEYS");

    expect({ builtIn, named, none }).toStrictEqual({
      // An EU organization's built-in transport: Bedrock's key alone.
      builtIn: { "bedrock-eu": "test-bedrock-eu-key" },
      named: {
        "bedrock-eu": "test-bedrock-eu-key",
        openrouter: "test-openrouter-key",
      },
      none: undefined,
    });
  });
});

/** What `task` was refused with: its code. */
const refusalOf = async (task: () => Promise<unknown>): Promise<unknown> => {
  try {
    await task();
  } catch (error) {
    return error instanceof Error && "code" in error ? error.code : "thrown";
  }
  return "taken";
};

/** The events `action` recorded, oldest first, each by its actor and detail. */
const eventsOf = async (action: string, clientId?: string) => {
  const rows = await db
    .select({ actor: auditEvents.actor, detail: auditEvents.detail })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, action),
        clientId === undefined
          ? isNull(auditEvents.clientId)
          : eq(auditEvents.clientId, clientId)
      )
    )
    .orderBy(auditEvents.at, sql`rowid`);
  return rows.map(({ actor, detail }) => ({
    actor,
    detail: z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(detail ?? "null")),
  }));
};

/** A client recorded and nothing more, as a new one is. */
const recordedClient = async (): Promise<string> => {
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date();
  await db
    .insert(clients)
    .values({ id: clientId, name: clientId, createdAt: now, updatedAt: now });
  return clientId;
};

const azure = {
  kind: "openai-compatible",
  name: "acme-azure",
  baseUrl: "https://acme.openai.azure.com/openai/v1",
  key: "acme-azure",
  models: { "openai/gpt-5": "gpt-5-eu" },
} as const;

describe("a client's model transport, as staff set it", () => {
  it("sets it audited once with what it replaced, marks the client for its next deploy, and takes it away again", async () => {
    const clientId = await recordedClient();
    const transport = {
      primary: { kind: "direct", "bedrock-eu": { key: "bedrock-eu" } },
      failover: [{ kind: "openrouter", key: "openrouter" }],
    };

    const set = await setModelTransport(env, staff, { clientId, transport });
    const again = await setModelTransport(env, staff, { clientId, transport });
    const [marked] = await db
      .select({ at: clients.configChangedAt })
      .from(clients)
      .where(eq(clients.id, clientId));
    const removed = await setModelTransport(env, staff, {
      clientId,
      transport: null,
    });
    const left = await db
      .select()
      .from(settings)
      .where(eq(settings.clientId, clientId));

    expect({
      set,
      again,
      removed,
      marked: marked?.at instanceof Date,
      left,
      events: await eventsOf("client.model_transport", clientId),
    }).toStrictEqual({
      set: true,
      again: false,
      removed: true,
      marked: true,
      left: [],
      events: [
        {
          actor: staff.email,
          detail: {
            from: "default",
            to: "direct:bedrock-eu > openrouter (global)",
          },
        },
        {
          actor: staff.email,
          detail: {
            from: "direct:bedrock-eu > openrouter (global)",
            to: "default",
          },
        },
      ],
    });
  });

  it("refuses a transport that isn't one, private hosts on a hosted client, and an attestation made as someone else, changing nothing", async () => {
    const clientId = await recordedClient();

    const refusals = {
      invalid: await refusalOf(
        async () =>
          await setModelTransport(env, staff, {
            clientId,
            transport: { primary: { kind: "openai-compatible", name: "x" } },
          })
      ),
      privateHosts: await refusalOf(
        async () =>
          await setModelTransport(env, staff, {
            clientId,
            transport: {
              primary: { ...azure, baseUrl: "http://models.acme.internal/v1" },
              privateHosts: ["models.acme.internal"],
            },
          })
      ),
      someoneElse: await refusalOf(
        async () =>
          await setModelTransport(env, staff, {
            clientId,
            transport: {
              primary: {
                ...azure,
                euAttestation: {
                  basis: "https://acme.example/dpa",
                  by: "someone@grasp.test",
                  at: new Date(0).toISOString(),
                },
              },
            },
          })
      ),
    };

    expect({
      refusals,
      events: await eventsOf("client.model_transport", clientId),
    }).toStrictEqual({
      refusals: {
        invalid: "model_transport_invalid",
        privateHosts: "private_hosts_on_prem_only",
        someoneElse: "attestation_not_yours",
      },
      events: [],
    });
  });

  it("records an EU attestation as made by the staff member saving it, now, and keeps it as it was when someone else saves the transport again", async () => {
    const clientId = await recordedClient();
    const before = Date.now();

    await setModelTransport(env, staff, {
      clientId,
      transport: {
        primary: {
          ...azure,
          euAttestation: { basis: "https://acme.example/dpa" },
        },
      },
    });
    const [saved] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.clientId, clientId));
    const attested = z
      .object({
        primary: z.object({
          euAttestation: z.object({
            basis: z.string(),
            by: z.string(),
            at: z.string(),
          }),
        }),
      })
      .parse(JSON.parse(saved?.value ?? "null")).primary.euAttestation;
    // Someone else saves it again unchanged: the attestation stays theirs.
    const resaved = await setModelTransport(
      env,
      { email: "other@grasp.test", sub: "sub-other" },
      {
        clientId,
        transport: { primary: { ...azure, euAttestation: attested } },
      }
    );

    expect({
      basis: attested.basis,
      by: attested.by,
      now: Date.parse(attested.at) >= before,
      resaved,
    }).toStrictEqual({
      basis: "https://acme.example/dpa",
      by: staff.email,
      now: true,
      resaved: false,
    });
  });
});

describe("the platform's default model transport", () => {
  useStoreSecrets({ deployer: token });

  it("shows each residency's default on Platform's AI page, the built-in one where staff set none", async () => {
    await db.delete(platformSettings);
    await setPlatformModelTransport(env, staff, {
      residency: "global",
      transport: {
        primary: { kind: "openrouter", key: "openrouter" },
        failover: [{ kind: "cloudflare-ai-gateway" }],
      },
    });

    const shown = await page("/platform/ai");
    const eu = textOf(sectionOf(shown.html, "EU organizations"));
    const global = textOf(
      sectionOf(shown.html, "Organizations whose AI may run anywhere")
    );
    await db.delete(platformSettings);

    expect({
      status: shown.status,
      eu: eu.includes(
        "The built-in default: The providers' own APIs: Claude in Amazon Bedrock, EU."
      ),
      global: global.includes(
        "OpenRouter. Fails over to Cloudflare AI Gateway."
      ),
    }).toStrictEqual({ status: 200, eu: true, global: true });
  });

  it("sets each residency's default audited once with what it replaced, and takes it away again", async () => {
    await db.delete(platformSettings);
    const earlier = await eventsOf("platform.model_transport");
    const transport = {
      primary: { kind: "direct", "bedrock-eu": { key: "bedrock-eu" } },
    };

    const set = await setPlatformModelTransport(env, staff, {
      residency: "eu",
      transport,
    });
    const again = await setPlatformModelTransport(env, staff, {
      residency: "eu",
      transport,
    });
    const defaults = await platformTransports(env);
    const removed = await setPlatformModelTransport(env, staff, {
      residency: "eu",
      transport: null,
    });
    const invalid = await refusalOf(
      async () =>
        await setPlatformModelTransport(env, staff, {
          residency: "global",
          transport: { primary: { kind: "direct" } },
        })
    );
    const events = await eventsOf("platform.model_transport");

    expect({
      set,
      again,
      removed,
      invalid,
      defaults,
      events: events.slice(earlier.length),
    }).toStrictEqual({
      set: true,
      again: false,
      removed: true,
      invalid: "model_transport_invalid",
      defaults: {
        eu: { ...transport, failover: [] },
        global: null,
      },
      events: [
        {
          actor: staff.email,
          detail: {
            residency: "eu",
            from: "built-in",
            to: "direct:bedrock-eu",
          },
        },
        {
          actor: staff.email,
          detail: {
            residency: "eu",
            from: "direct:bedrock-eu",
            to: "built-in",
          },
        },
      ],
    });
  });
});

/** Bedrock in Frankfurt, reached directly: an EU route. */
const bedrockRoute = {
  model: "bedrock-eu/claude-sonnet-5-5",
  transport: "direct",
  provider: "bedrock-eu",
  host: "bedrock-mantle.eu-central-1.api.aws",
  route: "direct/bedrock-eu",
  region: "eu-central-1",
  allowed: true,
} as const;

/** Bedrock reached through AI Gateway, which isn't pinned to the EU. */
const gatewayRoute = {
  model: "bedrock-eu/claude-sonnet-5-5",
  transport: "cloudflare-ai-gateway",
  provider: "bedrock-eu",
  host: "workers-binding.ai",
  route: "cloudflare-ai-gateway/bedrock-eu",
  region: "eu-central-1",
  allowed: false,
} as const;

describe("where a client's AI runs, as its Setup says", () => {
  useStoreSecrets({ deployer: token });

  it("says its AI runs in the EU when its core reaches its models in Bedrock's EU profile", async () => {
    const release = await placedRelease("feat(core): EU AI");
    const { clientId, account } = await livePlacedClient(
      cloudflare,
      1,
      release
    );
    account.modelTransport = {
      routes: [bedrockRoute],
      health: [
        {
          transport: "direct",
          lastOkAt: Date.parse("2026-10-29T08:00:00Z"),
          lastFailedAt: null,
          lastFailure: null,
          lastStatus: null,
        },
      ],
    };

    const status = await page(`/organizations/${clientId}/setup`);
    const ai = textOf(sectionOf(status.html, "AI"));

    expect({
      ai: [
        "AI runs in the EU (Amazon Bedrock in the EU (Frankfurt, EU inference profile)).",
        "The built-in default for EU organizations",
        "Only in the EU",
        "Amazon Web Services: Amazon Bedrock: runs Claude",
        "direct: last worked 2026-10-29 08:00 UTC, never failed.",
      ].map((text) => ai.includes(text)),
      missingKeys: ai.includes("Missing keys"),
    }).toStrictEqual({
      ai: [true, true, true, true, true],
      missingKeys: false,
    });
  });

  it("says an EU organization's AI can't run through AI Gateway, and names the keys its core lacks", async () => {
    const release = await placedRelease("feat(core): AI Gateway in the EU");
    const { clientId, account } = await livePlacedClient(
      cloudflare,
      1,
      release
    );
    await setModelTransport(env, staff, {
      clientId,
      transport: {
        primary: { kind: "cloudflare-ai-gateway" },
        failover: [{ kind: "direct", anthropic: { key: "acme-anthropic" } }],
      },
    });
    await deployPlaced(clientId, release);
    account.modelTransport = { routes: [gatewayRoute] };

    const status = await page(`/organizations/${clientId}/setup`);
    const ai = textOf(sectionOf(status.html, "AI"));

    expect({
      ai: [
        "AI can't run: no allowed model is reached in the EU (Amazon Bedrock in the EU, reached through AI Gateway, which isn't pinned to the EU).",
        "Its own setting",
        "acme-anthropic: not in MODEL_PROVIDER_KEYS",
      ].map((text) => ai.includes(text)),
    }).toStrictEqual({ ai: [true, true, true] });
  });

  it("asks its core for a probe as the staff member checking, and shows its metadata", async () => {
    const release = await placedRelease("feat(core): AI probe");
    const { clientId, account } = await livePlacedClient(
      cloudflare,
      1,
      release
    );
    const probe = {
      model: "bedrock-eu/claude-sonnet-5-5",
      ok: true,
      error: null,
      transport: "direct",
      region: "eu-central-1",
      ms: 812,
    };
    account.modelTransport = { routes: [bedrockRoute], probe };

    const read = await clientModelTransport(env, clientId);
    const checked = await clientModelTransport(env, clientId, staff);

    expect({
      read: read?.report?.probe,
      checked: checked?.report?.probe,
      asked: account.modelTransportAsks.map(({ probe: probed, staff: by }) => ({
        probed,
        by,
      })),
    }).toStrictEqual({
      read: null,
      checked: probe,
      asked: [
        { probed: false, by: undefined },
        { probed: true, by: staff.email },
      ],
    });
  });
});
