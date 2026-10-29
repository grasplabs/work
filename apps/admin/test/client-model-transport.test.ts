import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { adminDatabase } from "../src/db/act.ts";
import { settings } from "../src/db/schema.ts";
import { mockAccess } from "./access.ts";
import type { AccountState } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { deployPlaced, livePlacedClient, placedRelease } from "./placed.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// How a client's core reaches its models, from the admin: the provider
// keys a deploy gives it (only those its own transport names, from the
// store's), what staff set, where its Setup says its AI runs, and the
// hosting policy's check that its AI stays within the policy, from what
// its core reports.

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
