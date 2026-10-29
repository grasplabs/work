/**
 * The admin's Worker as Cloudflare's cf CLI deploys it (cloudflare.config.ts),
 * read from its wrangler.jsonc, which stays the one source of the admin's
 * bindings: the tests' pool, typegen and check:wrangler-configs read it too.
 * cf's config has no Wrangler environments and no keep_vars, so this:
 *
 * - takes the stage's view of wrangler.jsonc (the top level for production,
 *   `env.staging` over it for staging, as Wrangler merges them);
 * - declares each Durable Object class the migrations create, and each
 *   Workflow, as an export of cf's exports model (the admin's Worker is
 *   new on Grasp's account: nothing there was migrated the classic way);
 * - fills in what a deploy looks up (the account's Secrets Store and the
 *   stage's hostname map, `DeployInputs`), leaving out bindings to optional
 *   secrets the store doesn't have yet, and stopping on a required one;
 * - adds the admin's settings from the deploy's environment as text
 *   bindings, each only when it's set, in keep_vars' place.
 *
 * Pure: the deploy (deploy-platform) passes what it looked up in `inputs`.
 */
import { bindings, exports, triggers } from "cf/config";
import type { WorkerConfig } from "cf/config";

import { parseJsonc } from "../../scripts/jsonc.ts";
import { optionalSecrets } from "../../scripts/optional-secrets.ts";

/** The admin's settings, passed at deploy time (deploy-platform), never secrets. */
export const adminSettings = [
  "CF_ACCESS_AUD",
  "CF_ACCESS_ISS",
  "CLIENT_DOMAIN",
  "ENTRA_CLIENT_ID",
  "GRASP_CLIENT_ID",
  "ROOMS_ORIGIN",
  "ADMIN_HOST",
  "DISCORD_PUBLIC_KEY",
  "DISCORD_STAFF_IDS",
] as const;

/** What a deploy looked up, and the admin's settings; all unset for a build. */
export interface DeployInputs {
  /** The account's Secrets Store id. */
  SECRETS_STORE_ID?: string;
  /** The stage's router hostname map's KV namespace id. */
  ROUTER_HOSTS_ID?: string;
  /** The names of the secrets the store has, comma-separated. */
  STORED_SECRETS?: string;
  [setting: string]: string | undefined;
}

type Stage = "production" | "staging";
type Json = Record<string, unknown>;
type Env = NonNullable<WorkerConfig["env"]>;
type Exports = NonNullable<WorkerConfig["exports"]>;

/** The placeholders wrangler.jsonc names instead of per-account ids. */
const storePlaceholder = "account-secrets-store";
const hostsPlaceholder = "router-hosts-namespace";

const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `value` when it's an object, else an empty one. */
const objectOf = (value: unknown): Json => (isJson(value) ? value : {});

const list = (value: unknown): Json[] =>
  Array.isArray(value) ? value.filter(isJson) : [];

const text = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(text) : [];

/** Keys Wrangler doesn't inherit from the top level into an environment. */
const notInherited = new Set([
  "vars",
  "d1_databases",
  "r2_buckets",
  "kv_namespaces",
  "durable_objects",
  "workflows",
  "dispatch_namespaces",
  "secrets_store_secrets",
  "ratelimits",
  "services",
]);

/** `config`'s view for `stage`: an environment over the top level, as Wrangler merges them. */
const stageView = (config: Json, stage: Stage): Json => {
  if (stage === "production") {
    return config;
  }
  const env = objectOf(config.env).staging;
  if (!isJson(env)) {
    throw new Error("wrangler.jsonc has no env.staging");
  }
  const inherited = Object.fromEntries(
    Object.entries(config).filter(
      ([key]) => key !== "env" && !notInherited.has(key)
    )
  );
  return { ...inherited, ...env };
};

/** The Durable Object classes `config`'s migrations create, still live. */
const durableObjectClasses = (config: Json): string[] => {
  const live = new Set<string>();
  for (const migration of list(config.migrations)) {
    for (const name of [
      ...strings(migration.new_classes),
      ...strings(migration.new_sqlite_classes),
    ]) {
      live.add(name);
    }
    for (const name of strings(migration.deleted_classes)) {
      live.delete(name);
    }
  }
  return [...live];
};

/** Its vars, then the admin's settings the deploy set. */
const textBindings = (config: Json, inputs: DeployInputs): Env => {
  const env: Env = {};
  for (const [key, value] of Object.entries(objectOf(config.vars))) {
    env[key] = bindings.text(text(value));
  }
  for (const setting of adminSettings) {
    const value = inputs[setting];
    if (value !== undefined && value !== "") {
      env[setting] = bindings.text(value);
    }
  }
  return env;
};

/** Its D1 databases, R2 buckets, KV namespaces and dispatch namespaces. */
const storageBindings = (config: Json, inputs: DeployInputs): Env => {
  const env: Env = {};
  for (const database of list(config.d1_databases)) {
    env[text(database.binding)] = bindings.d1({
      name: text(database.database_name),
    });
  }
  for (const bucket of list(config.r2_buckets)) {
    env[text(bucket.binding)] = bindings.r2({
      name: text(bucket.bucket_name),
      ...(bucket.jurisdiction === undefined
        ? {}
        : { jurisdiction: text(bucket.jurisdiction) }),
    });
  }
  for (const namespace of list(config.kv_namespaces)) {
    const id = text(namespace.id);
    env[text(namespace.binding)] = bindings.kv({
      id: id === hostsPlaceholder ? (inputs.ROUTER_HOSTS_ID ?? id) : id,
    });
  }
  for (const namespace of list(config.dispatch_namespaces)) {
    env[text(namespace.binding)] = bindings.dispatchNamespace({
      namespace: text(namespace.namespace),
    });
  }
  return env;
};

/**
 * Its Secrets Store bindings, in the deploy's store: one to an optional
 * secret the store lacks is left out; a required one it lacks stops it.
 * Without STORED_SECRETS (a build), every binding stays.
 */
const secretBindings = (config: Json, inputs: DeployInputs): Env => {
  const stored =
    inputs.STORED_SECRETS === undefined
      ? undefined
      : new Set(
          inputs.STORED_SECRETS.split(",")
            .map((name) => name.trim())
            .filter(Boolean)
        );
  const env: Env = {};
  const missing: string[] = [];
  for (const secret of list(config.secrets_store_secrets)) {
    const secretName = text(secret.secret_name);
    if (stored !== undefined && !stored.has(secretName)) {
      // Optional by its binding: its store name is the stage's.
      if (!optionalSecrets.has(text(secret.binding))) {
        missing.push(secretName);
      }
      continue;
    }
    const storeId = text(secret.store_id);
    env[text(secret.binding)] = bindings.secretsStoreSecret({
      storeId:
        storeId === storePlaceholder
          ? (inputs.SECRETS_STORE_ID ?? storeId)
          : storeId,
      secretName,
    });
  }
  if (missing.length > 0) {
    throw new Error(
      `Secrets Store doesn't have ${missing.join(", ")}: put them in, then deploy again`
    );
  }
  return env;
};

/** Its Durable Objects, Workflows and rate limits, and the exports they need. */
const classBindings = (
  config: Json,
  worker: string
): { env: Env; exports: Exports } => {
  const env: Env = {};
  const declared: Exports = Object.fromEntries(
    durableObjectClasses(config).map((className) => [
      className,
      exports.durableObject({ storage: "sqlite" }),
    ])
  );
  for (const object of list(objectOf(config.durable_objects).bindings)) {
    env[text(object.name)] = bindings.durableObject({
      worker,
      exportName: text(object.class_name),
    });
  }
  for (const workflow of list(config.workflows)) {
    const exportName = text(workflow.class_name);
    env[text(workflow.binding)] = bindings.workflow({
      name: text(workflow.name),
      worker,
      exportName,
    });
    declared[exportName] = exports.workflow({ name: text(workflow.name) });
  }
  for (const limit of list(config.ratelimits)) {
    const simple = objectOf(limit.simple);
    // Cloudflare takes a rate limit's period in 10 or 60 seconds alone.
    const period = simple.period === 10 ? 10 : 60;
    if (simple.period !== period) {
      throw new Error(`${text(limit.name)}'s period isn't 10 or 60 seconds`);
    }
    env[text(limit.name)] = bindings.rateLimit({
      namespace: text(limit.namespace_id),
      simple: { limit: Number(simple.limit), period },
    });
  }
  return { env, exports: declared };
};

/**
 * The admin's Worker for cf in `stage`, from `wranglerText` (its
 * wrangler.jsonc) and what the deploy passed in `inputs`.
 */
export const cfWorker = (
  wranglerText: string,
  stage: Stage,
  inputs: DeployInputs
): WorkerConfig => {
  const config = stageView(objectOf(parseJsonc(wranglerText)), stage);
  const name = text(config.name);
  const observability = objectOf(config.observability);
  const classes = classBindings(config, name);
  return {
    name,
    compatibilityDate: text(config.compatibility_date),
    compatibilityFlags: strings(config.compatibility_flags),
    entrypoint: text(config.main),
    workersDev: config.workers_dev === true,
    previewUrls: config.preview_urls === true,
    observability: {
      enabled: observability.enabled === true,
      redactQueryString: observability.redact_query_string === true,
      logs: {
        invocationLogs: objectOf(observability.logs).invocation_logs === true,
      },
      traces: { enabled: objectOf(observability.traces).enabled === true },
    },
    triggers: strings(objectOf(config.triggers).crons).map((schedule) =>
      triggers.scheduled({ schedule })
    ),
    env: {
      ...textBindings(config, inputs),
      ...storageBindings(config, inputs),
      ...secretBindings(config, inputs),
      ...classes.env,
    },
    exports: classes.exports,
  };
};
