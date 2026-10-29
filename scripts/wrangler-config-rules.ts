/**
 * The rules every Worker's wrangler config (and any env in it that sets its
 * own) must follow, as a pure check over one config's text:
 * - turns off the platform's own log line per invocation, and
 * - redacts query strings, which carry OAuth codes and states and bearer
 *   links, so request URLs and secrets stay out of Workers Logs (threat
 *   model R17);
 * - turns off preview URLs, which would serve every uploaded version,
 *   older ones included, at an address of its own;
 * - is wrangler.jsonc, never TOML;
 * - declares its routes under `routes` alone, never wrangler's singular
 *   `route`, which the admin's deploy wouldn't read;
 * - for a platform Worker (the admin, the router, the connect gateway), names every Cloudflare
 *   resource, and declares the routes it answers on, as the shared names
 *   module (@grasp-os/shared/names) does, at the top level for production
 *   and in `env.staging` for staging.
 * `check-wrangler-configs.ts` runs it on every wrangler config in the repo.
 */
import {
  adminDatabaseName,
  clientsNamespace,
  platformWorkerName,
  releasesBucketName,
  storeSecretName,
  adminHost,
  clientDomain,
  platformRoutes,
} from "@grasp-os/shared/names";
import type { PlatformWorker, Stage } from "@grasp-os/shared/names";

import { parseJsonc } from "./jsonc.ts";

// Read by the scripts that take a config as JSONC, as they always have.
export { parseJsonc } from "./jsonc.ts";

/** `value[key]` when value is an object, else undefined. */
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

const observabilityErrors = (
  where: string,
  observability: unknown
): string[] => [
  ...(field(field(observability, "logs"), "invocation_logs") === false
    ? []
    : [`${where}: set observability.logs.invocation_logs to false.`]),
  ...(field(observability, "redact_query_string") === true
    ? []
    : [`${where}: set observability.redact_query_string to true.`]),
];

const previewUrlErrors = (where: string, previewUrls: unknown): string[] =>
  previewUrls === false ? [] : [`${where}: set preview_urls to false.`];

/**
 * Wrangler's singular `route`, refused: one form only, `routes`, which
 * every deploy reads, the admin's cf one included (apps/admin/cf-worker.ts).
 */
const routeErrors = (where: string, config: unknown): string[] =>
  field(config, "route") === undefined
    ? []
    : [`${where}: declare routes under "routes", not "route".`];

/** What `file`'s config, whose text is `text`, breaks of the rules above. */
export const wranglerConfigErrors = (file: string, text: string): string[] => {
  if (file.endsWith(".toml")) {
    return [`${file}: use wrangler.jsonc, as every Worker here does.`];
  }
  const config = parseJsonc(text);
  const errors = [
    ...observabilityErrors(file, field(config, "observability")),
    ...previewUrlErrors(file, field(config, "preview_urls")),
    ...routeErrors(file, config),
  ];
  // An environment that sets its own observability or preview_urls replaces
  // the top level's.
  const envs = field(config, "env") ?? {};
  for (const name of Object.keys(envs)) {
    const env = field(envs, name);
    const where = `${file} (env ${name})`;
    const observability = field(env, "observability");
    if (observability !== undefined) {
      errors.push(...observabilityErrors(where, observability));
    }
    const previewUrls = field(env, "preview_urls");
    if (previewUrls !== undefined) {
      errors.push(...previewUrlErrors(where, previewUrls));
    }
    errors.push(...routeErrors(where, env));
  }
  return errors;
};

/** The platform Workers' configs, by file. */
const platformConfigs: Readonly<Record<string, PlatformWorker>> = {
  "apps/admin/wrangler.jsonc": "admin",
  "apps/router/wrangler.jsonc": "router",
  "apps/gateway/wrangler.jsonc": "connect-gateway",
};

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * Every route `config` declares under `routes` (wrangler's singular
 * `route` is refused on its own, `routeErrors`), as one line to compare
 * and show: each pattern, its zone, and whether it's a Custom Domain. A
 * route given as a string is its pattern.
 */
const routesText = (config: unknown): string =>
  list(field(config, "routes"))
    .map((route) => (typeof route === "string" ? { pattern: route } : route))
    .map((route) =>
      [
        String(field(route, "pattern")),
        ...(field(route, "zone_name") === undefined
          ? []
          : [`zone ${String(field(route, "zone_name"))}`]),
        ...(field(route, "custom_domain") === true ? ["custom domain"] : []),
      ].join(" ")
    )
    .join(", ") || "none";

/** `config`'s names that aren't what @grasp-os/shared/names gives `worker` in `stage`. */
const stageNameErrors = (
  where: string,
  worker: PlatformWorker,
  stage: Stage,
  config: unknown
): string[] => {
  const errors: string[] = [];
  const expect = (what: string, actual: unknown, expected: string): void => {
    if (actual !== expected) {
      errors.push(`${where}: ${what} is ${String(actual)}, not ${expected}.`);
    }
  };
  expect("name", field(config, "name"), platformWorkerName(worker, stage));
  expect("vars.STAGE", field(field(config, "vars"), "STAGE"), stage);
  // Where it answers: without routes a deploy uploads it and serves it
  // nowhere; with another stage's, it takes that stage's traffic.
  expect(
    "routes",
    routesText(config),
    routesText({ routes: platformRoutes(worker, stage) })
  );
  for (const binding of list(field(config, "dispatch_namespaces"))) {
    expect(
      "the dispatch namespace",
      field(binding, "namespace"),
      clientsNamespace(stage)
    );
  }
  // Every secret by its stage's name in the one Secrets Store, so a
  // staging deploy never writes or reads what production does.
  for (const secret of list(field(config, "secrets_store_secrets"))) {
    const binding = field(secret, "binding");
    expect(
      `the Secrets Store secret of ${String(binding)}`,
      field(secret, "secret_name"),
      storeSecretName(String(binding), stage)
    );
  }
  if (worker === "admin") {
    const vars = field(config, "vars");
    expect(
      "vars.CLIENT_DOMAIN",
      field(vars, "CLIENT_DOMAIN"),
      clientDomain(stage)
    );
    expect("vars.ADMIN_HOST", field(vars, "ADMIN_HOST"), adminHost(stage));
    for (const database of list(field(config, "d1_databases"))) {
      expect(
        "the D1 database",
        field(database, "database_name"),
        adminDatabaseName(stage)
      );
    }
    for (const bucket of list(field(config, "r2_buckets"))) {
      expect(
        "the releases bucket",
        field(bucket, "bucket_name"),
        releasesBucketName(stage)
      );
    }
  }
  return errors;
};

/** Every rate limit namespace id `config` uses, in every stage. */
const rateLimitIds = (config: unknown): string[] => {
  const envs: unknown = field(config, "env");
  const stagesOf: unknown[] =
    typeof envs === "object" && envs !== null ? Object.values(envs) : [];
  return [config, ...stagesOf].flatMap((each) =>
    list(field(each, "ratelimits")).flatMap((limit) => {
      const id = field(limit, "namespace_id");
      return typeof id === "string" ? [id] : [];
    })
  );
};

/**
 * What platform config `file` (text `text`) names otherwise than the
 * shared names module does, in either stage; nothing for any other config.
 */
export const platformNameErrors = (file: string, text: string): string[] => {
  const worker = platformConfigs[file];
  if (worker === undefined) {
    return [];
  }
  const config = parseJsonc(text);
  const staging = field(field(config, "env"), "staging");
  return [
    ...stageNameErrors(file, worker, "production", config),
    ...(staging === undefined
      ? [`${file}: add env.staging, the staging platform's names.`]
      : stageNameErrors(`${file} (env staging)`, worker, "staging", staging)),
  ];
};

/**
 * Rate limit namespace ids every platform config and stage shares: they're
 * the account's, so staging and production need ids of their own.
 */
export const sharedRateLimitIds = (
  configs: readonly { file: string; text: string }[]
): string[] => {
  const ids = configs.flatMap(({ text }) => rateLimitIds(parseJsonc(text)));
  return [...new Set(ids.filter((id, at) => ids.indexOf(id) !== at))];
};
