import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { filledConfig } from "./wrangler-deploy-config.ts";
import type { ConfigLookups, DeployTarget } from "./wrangler-deploy-config.ts";

/**
 * The account as the Cloudflare API answers (the outside system): fixed
 * ids, a store holding `stored`, and a note of what was asked.
 */
const account = (stored: readonly string[] = []) => {
  const asked: string[] = [];
  const lookups: ConfigLookups = {
    storeId: async () => {
      asked.push("store");
      return await Promise.resolve("store-1");
    },
    hostsId: async () => {
      asked.push("hosts");
      return await Promise.resolve("hosts-1");
    },
    storedSecrets: async (id) => {
      asked.push(`secrets of ${id}`);
      return await Promise.resolve(new Set(stored));
    },
  };
  return { asked, lookups };
};

const production: DeployTarget = { env: undefined, optional: new Set() };
const staging: DeployTarget = { env: "staging", optional: new Set() };

const router = readFileSync("apps/router/wrangler.jsonc", "utf-8");

/** How a deploy's config came out: "deploys", or why it stopped. */
const outcome = async (running: Promise<string>): Promise<string> => {
  try {
    await running;
    return "deploys";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

describe("a Worker's config as it deploys", () => {
  it("deploys a config with no placeholder as it is, looking nothing up: the connect gateway's", async () => {
    const gateway = readFileSync("apps/gateway/wrangler.jsonc", "utf-8");
    const { asked, lookups } = account();

    expect({
      deployed: await filledConfig(gateway, lookups, production),
      asked,
    }).toStrictEqual({ deployed: gateway, asked: [] });
  });

  it("fills in the store and the router's map, and checks the store's secrets", async () => {
    const { asked, lookups } = account(["KEY"]);
    const config = `{
  "secrets_store_secrets": [{ "binding": "KEY", "store_id": "account-secrets-store", "secret_name": "KEY" }],
  "kv_namespaces": [{ "binding": "HOSTS", "id": "router-hosts-namespace" }],
}`;

    expect({
      deployed: await filledConfig(config, lookups, production),
      asked,
    }).toStrictEqual({
      deployed: config
        .replace('"account-secrets-store"', '"store-1"')
        .replace('"router-hosts-namespace"', '"hosts-1"'),
      asked: ["store", "hosts", "secrets of store-1"],
    });
  });

  it("deploys the router's stage when the store lacks only the other stage's key", async () => {
    expect({
      production: await outcome(
        filledConfig(router, account(["ROUTER_KEY"]).lookups, production)
      ),
      staging: await outcome(
        filledConfig(router, account(["ROUTER_KEY_STAGING"]).lookups, staging)
      ),
    }).toStrictEqual({ production: "deploys", staging: "deploys" });
  });

  it("stops before deploying when the store lacks the deployed stage's own key", async () => {
    expect({
      production: await outcome(
        filledConfig(
          router,
          account(["ROUTER_KEY_STAGING"]).lookups,
          production
        )
      ),
      staging: await outcome(
        filledConfig(router, account(["ROUTER_KEY"]).lookups, staging)
      ),
    }).toStrictEqual({
      production:
        "Secrets Store store-1 doesn't have ROUTER_KEY: add ROUTER_KEY to the stage's 1Password Environment, then run Deploy platform again",
      staging:
        "Secrets Store store-1 doesn't have ROUTER_KEY_STAGING: add ROUTER_KEY to the stage's 1Password Environment, then run Deploy platform again",
    });
  });

  it("knows an optional secret by its binding, under its staging name too", async () => {
    const built = JSON.stringify({
      name: "grasp-admin-staging",
      secrets_store_secrets: [
        {
          binding: "ROOMS_READ_TOKEN",
          store_id: "account-secrets-store",
          secret_name: "ROOMS_READ_TOKEN_STAGING",
        },
      ],
    });
    const deployed: unknown = JSON.parse(
      await filledConfig(built, account().lookups, {
        env: undefined,
        optional: new Set(["ROOMS_READ_TOKEN"]),
      })
    );

    expect(deployed).toStrictEqual({
      name: "grasp-admin-staging",
      secrets_store_secrets: [],
    });
  });

  it("leaves an optional secret the store lacks unbound, and deploys the rest", async () => {
    const built = JSON.stringify({
      name: "grasp-admin-staging",
      secrets_store_secrets: [
        {
          binding: "KEY",
          store_id: "account-secrets-store",
          secret_name: "KEY",
        },
        {
          binding: "ROOMS_READ_TOKEN",
          store_id: "account-secrets-store",
          secret_name: "ROOMS_READ_TOKEN",
        },
      ],
    });
    const deployed: unknown = JSON.parse(
      await filledConfig(built, account(["KEY"]).lookups, {
        env: undefined,
        optional: new Set(["ROOMS_READ_TOKEN"]),
      })
    );

    expect(deployed).toStrictEqual({
      name: "grasp-admin-staging",
      secrets_store_secrets: [
        { binding: "KEY", store_id: "store-1", secret_name: "KEY" },
      ],
    });
  });
});
