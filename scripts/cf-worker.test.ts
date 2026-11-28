import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vite-plus/test";

import { cfWorker } from "../apps/admin/cf-worker.ts";

// The admin's Worker as cf deploys it (apps/admin/cf-worker.ts), from the
// real apps/admin/wrangler.jsonc: each stage's names, what a deploy
// looked up filled in, optional secrets the store lacks left out, a
// required one stopping it, a queue the account lacks not consumed, and
// the settings keep_vars used to keep.

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
  "STRIPE_RESTRICTED_KEY",
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

/** The queues `worker` consumes. */
const consumers = (worker: ReturnType<typeof cfWorker>) =>
  worker.triggers?.filter((each) => each.type === "queue");

/** The admin's consumer of queue `name`, as cf takes it. */
const consumer = (name: string) => [
  {
    type: "queue",
    name,
    maxBatchTimeout: 0,
    maxConcurrency: 1,
    maxRetries: 0,
  },
];

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
      // A route for its own hostname in each stage, and no Custom Domain.
      domains: [production.domains, staging.domains],
      routes: [production, staging].map((worker) =>
        worker.triggers?.filter((each) => each.type === "fetch")
      ),
      // Inherited by staging from the top level, as Wrangler does.
      crons: staging.triggers?.filter((each) => each.type === "scheduled")
        .length,
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
      domains: [[], []],
      routes: [
        [
          {
            type: "fetch",
            pattern: "admin.ongrasp.app/*",
            zone: "ongrasp.app",
          },
        ],
        [
          {
            type: "fetch",
            pattern: "admin.staging.ongrasp.app/*",
            zone: "ongrasp.app",
          },
        ],
      ],
      crons: 2,
      redacted: true,
    });
  });

  it("fills in the store and the hostname map a deploy looked up, and declares its classes as exports, a deleted one as a tombstone", () => {
    const worker = cfWorker(wranglerText, "production", deployed);
    expect({
      store: bindingOf(worker, "CLIENT_KEY"),
      hosts: bindingOf(worker, "ROUTER_HOSTS"),
      chat: bindingOf(worker, "CHAT_STATE"),
      deleted: worker.exports?.ChatState,
      runs: worker.exports?.AdminRuns,
    }).toStrictEqual({
      store: {
        type: "secrets-store-secret",
        storeId: "store-1",
        secretName: "CLIENT_KEY",
      },
      hosts: { type: "kv", id: "hosts-1" },
      chat: undefined,
      deleted: { type: "durable-object", state: "deleted" },
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

  it("binds the alert mail only once the deploy passes who it's from and its one mailbox, to those alone", () => {
    const mail = {
      ALERTS_MAIL_FROM: "alerts@mail.grasp.test",
      ALERTS_MAIL_TO: "ops@grasp.test",
    };
    const configured = cfWorker(wranglerText, "staging", {
      ...deployed,
      ...mail,
    });
    expect({
      binding: bindingOf(configured, "ALERTS_MAIL"),
      from: bindingOf(configured, "ALERTS_MAIL_FROM")?.value,
      to: bindingOf(configured, "ALERTS_MAIL_TO")?.value,
      onlyFrom: bindingOf(
        cfWorker(wranglerText, "staging", {
          ...deployed,
          ALERTS_MAIL_FROM: mail.ALERTS_MAIL_FROM,
        }),
        "ALERTS_MAIL"
      ),
      unset: bindingOf(
        cfWorker(wranglerText, "production", deployed),
        "ALERTS_MAIL"
      ),
    }).toStrictEqual({
      binding: {
        type: "send-email",
        destinationAddress: "ops@grasp.test",
        allowedSenderAddresses: ["alerts@mail.grasp.test"],
      },
      from: "alerts@mail.grasp.test",
      to: "ops@grasp.test",
      onlyFrom: undefined,
      unset: undefined,
    });
  });

  it("consumes each stage's release manifests' queue once the account has it, and keeps the CPU limit", () => {
    const queues = "grasp-release-manifests,grasp-release-manifests-staging";
    expect({
      production: consumers(
        cfWorker(wranglerText, "production", { ...deployed, QUEUES: queues })
      ),
      staging: consumers(
        cfWorker(wranglerText, "staging", { ...deployed, QUEUES: queues })
      ),
      // Not made yet: left out, as a deploy naming it stops.
      missing: consumers(
        cfWorker(wranglerText, "staging", { ...deployed, QUEUES: "" })
      ),
      // A build passes no QUEUES: the consumer stays.
      build: consumers(cfWorker(wranglerText, "staging", {})),
      limits: cfWorker(wranglerText, "staging", deployed).limits,
    }).toStrictEqual({
      production: consumer("grasp-release-manifests"),
      staging: consumer("grasp-release-manifests-staging"),
      missing: [],
      build: consumer("grasp-release-manifests-staging"),
      limits: { cpuMs: 120_000 },
    });
  });

  it("defers its runs' code updates in both stages, as upload metadata cf deploys with", () => {
    const deferred = {
      metadata: { code_update_strategy: { mode: "deferred", max_delay: 900 } },
    };
    expect({
      production: cfWorker(wranglerText, "production", deployed).unsafe,
      staging: cfWorker(wranglerText, "staging", deployed).unsafe,
    }).toStrictEqual({ production: deferred, staging: deferred });
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

/**
 * Every module `file` imports or re-exports, by its specifier, as oxc
 * parses it: type-only ones too, and a dynamic import of a string.
 */
const importsOf = (file: string): string[] => {
  const source = readFileSync(file, "utf-8");
  const { module, errors } = parseSync(file, source);
  if (errors.length > 0) {
    throw new Error(`${file} doesn't parse: ${errors[0]?.message ?? ""}`);
  }
  const dynamic = module.dynamicImports.flatMap(({ moduleRequest }) => {
    const written = source.slice(moduleRequest.start, moduleRequest.end);
    const quoted = /^["'`](?<specifier>[^"'`]+)["'`]$/u.exec(written);
    return quoted?.groups?.specifier === undefined
      ? []
      : [quoted.groups.specifier];
  });
  return [
    ...module.staticImports.map(({ moduleRequest }) => moduleRequest.value),
    ...module.staticExports.flatMap(({ entries }) =>
      entries.flatMap(({ moduleRequest }) =>
        moduleRequest === null ? [] : [moduleRequest.value]
      )
    ),
    ...dynamic,
  ];
};

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

// Vite's Cloudflare plugin loads cloudflare.config.ts on its own, before
// the Worker's modules are built: a workspace package the config reached
// would bring in modules only the Worker's build can load, and the admin's
// dev server and build would fail to start.
describe("the admin's cf config as Vite's Cloudflare plugin loads it", () => {
  it("loads from the admin's own files alone, reaching no workspace package", () => {
    expect(
      workspaceImports(
        path.join(import.meta.dirname, "../apps/admin/cloudflare.config.ts")
      )
    ).toStrictEqual([]);
  });
});
