import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { cfWorker } from "../apps/admin/cf-worker.ts";

// The admin's Worker as cf deploys it (apps/admin/cf-worker.ts), from the
// real apps/admin/wrangler.jsonc: each stage's names, what a deploy
// looked up filled in, optional secrets the store lacks left out, a
// required one stopping it, and the settings keep_vars used to keep.

/** The admin's real wrangler.jsonc. */
const wranglerText = readFileSync(
  path.join(import.meta.dirname, "../apps/admin/wrangler.jsonc"),
  "utf-8"
);
/** The same without either stage's Access application tag. */
const withoutAudience = wranglerText.replaceAll(
  /^\s*"CF_ACCESS_AUD": "[0-9a-f]+",\n/gmu,
  ""
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

/** Every secret the admin binds, by its binding name. */
const adminSecrets = [
  "DEPLOYER_API_TOKEN",
  "ROUTER_KEY",
  "CLIENT_KEY",
  "ENTRA_CLIENT_SECRET",
  "MICROSOFT_CLIENT_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "COMPOSIO_API_KEY",
  "APP_OAUTH_CLIENTS",
  "PLAN_SIGNING_KEY",
  "AGENT_DISPATCH_TOKEN",
  "STRIPE_RESTRICTED_KEY",
  "ROOMS_READ_TOKEN",
  "DISCORD_DIGEST_WEBHOOK",
  "STAFF_ALERTS_WEBHOOK",
  "ATTIO_READ_KEY",
];
/** Each stage's names for them in the store. */
const productionSecrets = adminSecrets;
const stagingSecrets = adminSecrets.map((name) => `${name}_STAGING`);
/** Every secret both stages bind, as STORED_SECRETS lists them. */
const everySecret = [...productionSecrets, ...stagingSecrets].join(",");

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
      // Staging's, under its staging name, is optional just the same.
      stagingOptional: bindingOf(
        cfWorker(wranglerText, "staging", {
          ...deployed,
          STORED_SECRETS: everySecret
            .split(",")
            .filter((name) => name !== "STRIPE_RESTRICTED_KEY_STAGING")
            .join(","),
        }),
        "STRIPE_RESTRICTED_KEY"
      ),
      // A build passes no STORED_SECRETS: every binding stays.
      build: bindingOf(
        cfWorker(wranglerText, "production", {}),
        "STRIPE_RESTRICTED_KEY"
      )?.storeId,
    }).toStrictEqual({
      optional: undefined,
      stagingOptional: undefined,
      build: "account-secrets-store",
    });
    expect(() =>
      cfWorker(wranglerText, "production", {
        ...deployed,
        STORED_SECRETS: withoutRequired,
      })
    ).toThrow("Secrets Store doesn't have DEPLOYER_API_TOKEN");
  });

  it("deploys each stage when the store lacks only the other stage's secrets", () => {
    const without = (names: readonly string[]): string =>
      everySecret
        .split(",")
        .filter((name) => !names.includes(name))
        .join(",");
    expect({
      production: cfWorker(wranglerText, "production", {
        ...deployed,
        STORED_SECRETS: without(stagingSecrets),
      }).name,
      staging: cfWorker(wranglerText, "staging", {
        ...deployed,
        STORED_SECRETS: without(productionSecrets),
      }).name,
    }).toStrictEqual({
      production: "grasp-admin",
      staging: "grasp-admin-staging",
    });
  });

  it("takes every setting from the stage's vars in wrangler.jsonc", () => {
    const settings = (stage: "production" | "staging") => {
      const worker = cfWorker(wranglerText, stage, deployed);
      return Object.fromEntries(
        [
          "STAGE",
          "CF_ACCESS_ISS",
          "ENTRA_CLIENT_ID",
          "GOOGLE_CLIENT_ID",
          "CLIENT_DOMAIN",
          "ADMIN_HOST",
        ].map((name) => [name, bindingOf(worker, name)?.value])
      );
    };
    expect({
      production: settings("production"),
      staging: settings("staging"),
    }).toStrictEqual({
      production: {
        STAGE: "production",
        CF_ACCESS_ISS: "https://grasp-work.cloudflareaccess.com",
        ENTRA_CLIENT_ID: "01228906-bd5b-488e-b7c1-720f4dc12dc2",
        GOOGLE_CLIENT_ID:
          "740037143590-b2d0cpupcj0t800rth3ekr6g310unatv.apps.googleusercontent.com",
        CLIENT_DOMAIN: "ongrasp.app",
        ADMIN_HOST: "admin.ongrasp.app",
      },
      staging: {
        STAGE: "staging",
        CF_ACCESS_ISS: "https://grasp-work.cloudflareaccess.com",
        ENTRA_CLIENT_ID: "01228906-bd5b-488e-b7c1-720f4dc12dc2",
        GOOGLE_CLIENT_ID:
          "740037143590-9sb4tsn4di5lqvq5vc1ldtr2kgmm16p2.apps.googleusercontent.com",
        CLIENT_DOMAIN: "staging.ongrasp.app",
        ADMIN_HOST: "admin.staging.ongrasp.app",
      },
    });
  });

  it("stops a deploy of a stage without its Access application, but still builds it", () => {
    expect(() => cfWorker(withoutAudience, "staging", deployed)).toThrow(
      "Set CF_ACCESS_AUD in apps/admin/wrangler.jsonc for staging"
    );
    expect(cfWorker(withoutAudience, "staging", {}).name).toBe(
      "grasp-admin-staging"
    );
  });

  it("stops a staging deploy whose store lacks a required secret, naming its staging name", () => {
    expect(() =>
      cfWorker(wranglerText, "staging", {
        ...deployed,
        STORED_SECRETS: everySecret
          .split(",")
          .filter((name) => name !== "GOOGLE_CLIENT_SECRET_STAGING")
          .join(","),
      })
    ).toThrow("Secrets Store doesn't have GOOGLE_CLIENT_SECRET_STAGING");
  });
});

/** Every module specifier `file` imports. */
const importsOf = (file: string): string[] =>
  [
    ...readFileSync(file, "utf-8").matchAll(
      /^import[^"']*["'](?<specifier>[^"']+)["']/gmu
    ),
  ].flatMap((match) =>
    match.groups?.specifier === undefined ? [] : [match.groups.specifier]
  );

/** The workspace packages `entry` reaches through its relative imports. */
const workspaceImports = (entry: string): string[] => {
  const seen = new Set<string>();
  const found = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) {
      return;
    }
    seen.add(file);
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith("@grasp-os/")) {
        found.add(specifier);
      } else if (specifier.startsWith(".")) {
        const target = path.resolve(path.dirname(file), specifier);
        if (existsSync(target)) {
          visit(target);
        }
      }
    }
  };
  visit(entry);
  return [...found];
};

describe("the admin's cf config as Vite's Cloudflare plugin loads it", () => {
  it("reaches none of the modules the Worker loads, which broke the dev server", () => {
    expect(
      workspaceImports(
        path.join(import.meta.dirname, "../apps/admin/cloudflare.config.ts")
      )
    ).toStrictEqual([]);
  });
});
