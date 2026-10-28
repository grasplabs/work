import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { filledConfig } from "./wrangler-deploy-config.ts";
import type { ConfigLookups } from "./wrangler-deploy-config.ts";

/** Lookups that note what was asked, answering with fixed ids. */
const noting = () => {
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
    withStoredSecrets: async (config, id) => {
      asked.push(`secrets of ${id}`);
      return await Promise.resolve(config);
    },
  };
  return { asked, lookups };
};

describe("a Worker's config as it deploys", () => {
  it("deploys a config with no placeholder as it is, looking nothing up: the connect gateway's", async () => {
    const gateway = readFileSync("apps/gateway/wrangler.jsonc", "utf-8");
    const { asked, lookups } = noting();

    expect({
      deployed: await filledConfig(gateway, lookups),
      asked,
    }).toStrictEqual({ deployed: gateway, asked: [] });
  });

  it("fills in the store and the router's map, and checks the store's secrets", async () => {
    const { asked, lookups } = noting();
    const config = `{
  "secrets_store_secrets": [{ "binding": "KEY", "store_id": "account-secrets-store", "secret_name": "KEY" }],
  "kv_namespaces": [{ "binding": "HOSTS", "id": "router-hosts-namespace" }],
}`;

    expect({
      deployed: await filledConfig(config, lookups),
      asked,
    }).toStrictEqual({
      deployed: config
        .replace('"account-secrets-store"', '"store-1"')
        .replace('"router-hosts-namespace"', '"hosts-1"'),
      asked: ["store", "hosts", "secrets of store-1"],
    });
  });
});
