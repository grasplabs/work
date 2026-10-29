import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { adminSettings, cfWorker } from "../apps/admin/cf-worker.ts";

// The admin's Worker as cf deploys it (apps/admin/cf-worker.ts), from the
// real apps/admin/wrangler.jsonc: each stage's names, what a deploy
// looked up filled in, optional secrets the store lacks left out, a
// required one stopping it, and the settings keep_vars used to keep.

const wranglerText = readFileSync(
  path.join(import.meta.dirname, "../apps/admin/wrangler.jsonc"),
  "utf-8"
);

/** A field of a binding, as cf's builders shape it. */
const bindingOf = (
  worker: ReturnType<typeof cfWorker>,
  name: string
): Record<string, unknown> | undefined => {
  const binding: unknown = worker.env?.[name];
  return typeof binding === "object" && binding !== null
    ? Object.fromEntries(Object.entries(binding))
    : undefined;
};

/** Every secret the config binds, as STORED_SECRETS lists them. */
const everySecret = [
  "DEPLOYER_API_TOKEN",
  "DEPLOYER_API_TOKEN_STAGING",
  "ROUTER_KEY",
  "CLIENT_KEY",
  "ROUTER_KEY_STAGING",
  "CLIENT_KEY_STAGING",
  "ENTRA_CLIENT_SECRET",
  "MICROSOFT_CLIENT_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "COMPOSIO_API_KEY",
  "APP_OAUTH_CLIENTS",
  "STRIPE_RESTRICTED_KEY",
  "ROOMS_READ_TOKEN",
  "DISCORD_DIGEST_WEBHOOK",
  "STAFF_ALERTS_WEBHOOK",
  "ATTIO_READ_KEY",
].join(",");

const deployed = {
  SECRETS_STORE_ID: "store-1",
  ROUTER_HOSTS_ID: "hosts-1",
  STORED_SECRETS: everySecret,
};

describe("the admin's Worker for cf", () => {
  it("names every resource for its stage, from the stage's view of wrangler.jsonc", () => {
    const production = cfWorker(wranglerText, "production", deployed);
    const staging = cfWorker(wranglerText, "staging", deployed);
    expect({
      names: [production.name, staging.name],
      databases: [bindingOf(production, "DB"), bindingOf(staging, "DB")],
      namespaces: [
        bindingOf(production, "DISPATCHER")?.namespace,
        bindingOf(staging, "DISPATCHER")?.namespace,
      ],
      routerKeys: [
        bindingOf(production, "ROUTER_KEY")?.secretName,
        bindingOf(staging, "ROUTER_KEY")?.secretName,
      ],
      deployers: [
        bindingOf(production, "DEPLOYER_API_TOKEN")?.secretName,
        bindingOf(staging, "DEPLOYER_API_TOKEN")?.secretName,
      ],
      runs: [
        bindingOf(production, "ADMIN_RUNS")?.worker,
        bindingOf(staging, "ADMIN_RUNS")?.worker,
      ],
      stages: [
        bindingOf(production, "STAGE")?.value,
        bindingOf(staging, "STAGE")?.value,
      ],
      // Inherited by staging from the top level, as Wrangler does.
      crons: staging.triggers?.length,
      redacted: staging.observability?.redactQueryString,
    }).toStrictEqual({
      names: ["grasp-admin", "grasp-admin-staging"],
      databases: [
        { type: "d1", name: "grasp-admin" },
        { type: "d1", name: "grasp-admin-staging" },
      ],
      namespaces: ["grasp-clients", "grasp-clients-staging"],
      routerKeys: ["ROUTER_KEY", "ROUTER_KEY_STAGING"],
      deployers: ["DEPLOYER_API_TOKEN", "DEPLOYER_API_TOKEN_STAGING"],
      runs: ["grasp-admin", "grasp-admin-staging"],
      stages: ["production", "staging"],
      crons: 4,
      redacted: true,
    });
  });

  it("fills in the store and the hostname map a deploy looked up, and declares its classes as exports", () => {
    const worker = cfWorker(wranglerText, "production", deployed);
    expect({
      store: bindingOf(worker, "CLIENT_KEY"),
      hosts: bindingOf(worker, "ROUTER_HOSTS"),
      chat: bindingOf(worker, "CHAT_STATE"),
      exports: worker.exports?.ChatState,
      runs: worker.exports?.AdminRuns,
    }).toStrictEqual({
      store: {
        type: "secrets-store-secret",
        storeId: "store-1",
        secretName: "CLIENT_KEY",
      },
      hosts: { type: "kv", id: "hosts-1" },
      chat: {
        type: "durable-object",
        worker: "grasp-admin",
        exportName: "ChatState",
      },
      exports: { type: "durable-object", storage: "sqlite" },
      runs: { type: "durable-object", storage: "sqlite" },
    });
  });

  it("leaves out optional secrets the store lacks, and stops on a required one", () => {
    const withoutOptional = everySecret
      .split(",")
      .filter((name) => name !== "STRIPE_RESTRICTED_KEY")
      .join(",");
    const withoutRequired = everySecret
      .split(",")
      .filter((name) => name !== "DEPLOYER_API_TOKEN")
      .join(",");
    expect({
      optional: bindingOf(
        cfWorker(wranglerText, "production", {
          ...deployed,
          STORED_SECRETS: withoutOptional,
        }),
        "STRIPE_RESTRICTED_KEY"
      ),
      // A build passes no STORED_SECRETS: every binding stays.
      build: bindingOf(
        cfWorker(wranglerText, "production", {}),
        "STRIPE_RESTRICTED_KEY"
      )?.storeId,
    }).toStrictEqual({ optional: undefined, build: "account-secrets-store" });
    expect(() =>
      cfWorker(wranglerText, "production", {
        ...deployed,
        STORED_SECRETS: withoutRequired,
      })
    ).toThrow("Secrets Store doesn't have DEPLOYER_API_TOKEN");
  });

  it("deploys each stage when the store lacks only the other stage's keys", () => {
    const without = (names: readonly string[]): string =>
      everySecret
        .split(",")
        .filter((name) => !names.includes(name))
        .join(",");
    const stagingKeys = [
      "DEPLOYER_API_TOKEN_STAGING",
      "ROUTER_KEY_STAGING",
      "CLIENT_KEY_STAGING",
    ];
    const productionKeys = ["DEPLOYER_API_TOKEN", "ROUTER_KEY", "CLIENT_KEY"];
    expect({
      production: cfWorker(wranglerText, "production", {
        ...deployed,
        STORED_SECRETS: without(stagingKeys),
      }).name,
      staging: cfWorker(wranglerText, "staging", {
        ...deployed,
        STORED_SECRETS: without(productionKeys),
      }).name,
    }).toStrictEqual({
      production: "grasp-admin",
      staging: "grasp-admin-staging",
    });
  });

  it("adds the admin's settings from the deploy, each only when it's set", () => {
    const worker = cfWorker(wranglerText, "staging", {
      ...deployed,
      CF_ACCESS_AUD: "aud-1",
      CLIENT_DOMAIN: "",
      NOT_A_SETTING: "kept out",
    });
    expect({
      aud: bindingOf(worker, "CF_ACCESS_AUD"),
      domain: bindingOf(worker, "CLIENT_DOMAIN"),
      other: bindingOf(worker, "NOT_A_SETTING"),
      settings: adminSettings.includes("CF_ACCESS_ISS"),
    }).toStrictEqual({
      aud: { type: "text", value: "aud-1" },
      domain: undefined,
      other: undefined,
      settings: true,
    });
  });
});
