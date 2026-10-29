/**
 * Deploys the Worker in the current directory, for the stage `--stage`
 * names (staging or production, by the shared names module), with the ids wrangler can't
 * look up filled in: its Secrets Store bindings pointed at the account's
 * own store, and a binding to the router's hostname map at that
 * namespace. Both ids differ per account,
 * so the config carries placeholders and this fills them in before
 * `wrangler deploy` (`filledConfig`, ./wrangler-deploy-config.ts); a config
 * with neither, such as the connect gateway's, deploys as it is:
 * - `"account-secrets-store"`: from SECRETS_STORE_ID when the job sets it
 *   (deploy-platform does), otherwise from the Cloudflare API, as the
 *   account's only store;
 * - `"router-hosts-namespace"`: the router's hostname map, which
 *   scripts/cloudflare-account-setup.ts creates as `grasp-router-hosts`
 *   (`-staging` for staging), from the Cloudflare API.
 *
 * Only the deployed stage's Secrets Store bindings are checked against the
 * store: one to an optional secret (`optionalSecrets`) the store lacks is
 * left out, any other the store lacks stops the deploy (`filledConfig`).
 *
 * A Worker built with the Cloudflare Vite plugin (the admin) deploys the
 * config its build wrote, which `.wrangler/deploy/config.json` points to;
 * any other deploys its wrangler.jsonc. Arguments are passed on to
 * `wrangler deploy`, such as the admin's `--var`s.
 *
 * The lookups need CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (with
 * Secrets Store and Workers KV read), as the deploy jobs set them.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { routerHostsName, stageOf } from "@grasp-os/shared/names";

import { filledConfig } from "./wrangler-deploy-config.ts";

/**
 * The stage `--stage` names (production unless it says staging), and the
 * arguments for wrangler without it.
 */
const stageAt = process.argv.indexOf("--stage");
const stage = stageOf(stageAt === -1 ? undefined : process.argv[stageAt + 1]);
const wranglerArgs = process.argv
  .slice(2)
  .filter(
    (_arg, at) => stageAt === -1 || (at !== stageAt - 2 && at !== stageAt - 1)
  );
/** The title of the stage's hostname map. */
const hostsTitle = routerHostsName(stage);
/** Where the Cloudflare Vite plugin's build says its config is. */
const buildRedirect = ".wrangler/deploy/config.json";
/**
 * Secrets a Worker runs without, until someone puts them in the store: the
 * admin's apps' OAuth clients, Stripe, Rooms, Attio and its Discord
 * webhooks (apps/admin/wrangler.jsonc).
 */
const optionalSecrets: ReadonlySet<string> = new Set([
  "APP_OAUTH_CLIENTS",
  "STRIPE_RESTRICTED_KEY",
  "ROOMS_READ_TOKEN",
  "ATTIO_READ_KEY",
  "DISCORD_DIGEST_WEBHOOK",
  "STAFF_ALERTS_WEBHOOK",
]);

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
};

/** `value[key]` when value is an object, else undefined. */
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

const isList = (value: unknown): value is unknown[] => Array.isArray(value);

/** Every item of the account's list at `list`, page by page. */
const listAll = async (list: string): Promise<unknown[]> => {
  const accountId = required("CLOUDFLARE_ACCOUNT_ID");
  const items: unknown[] = [];
  for (let page = 1; ; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}${list}?per_page=100&page=${page}`,
      {
        headers: {
          authorization: `Bearer ${required("CLOUDFLARE_API_TOKEN")}`,
        },
      }
    );
    if (!response.ok) {
      throw new Error(`Listing the account's ${list}: HTTP ${response.status}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const body: unknown = await response.json();
    const result = field(body, "result");
    if (isList(result)) {
      items.push(...result);
    }
    const totalPages = Number(
      field(field(body, "result_info"), "total_pages") ?? 1
    );
    if (!isList(result) || page >= totalPages) {
      return items;
    }
  }
};

/** The ids of the items in `items` that `matches` picks out. */
const idsOf = (
  items: unknown[],
  matches: (item: unknown) => boolean
): string[] =>
  items.flatMap((item) => {
    const id = field(item, "id");
    return matches(item) && typeof id === "string" ? [id] : [];
  });

/** The one id in `ids`, or an error naming what was expected. */
const onlyId = (ids: string[], expected: string): string => {
  const [id] = ids;
  if (id === undefined || ids.length > 1) {
    throw new Error(
      `Expected the account to have ${expected}, found ${ids.length}`
    );
  }
  return id;
};

/** The store id the job gives, else the account's only store's. */
const storeId = async (): Promise<string> => {
  const configured = process.env.SECRETS_STORE_ID;
  if (configured !== undefined && configured !== "") {
    return configured;
  }
  return onlyId(
    idsOf(await listAll("/secrets_store/stores"), () => true),
    "one Secrets Store"
  );
};

/** The names of the secrets in store `id`. */
const storedSecrets = async (id: string): Promise<ReadonlySet<string>> => {
  const secrets = await listAll(`/secrets_store/stores/${id}/secrets`);
  return new Set(
    secrets.flatMap((secret) => {
      const name = field(secret, "name");
      return typeof name === "string" ? [name] : [];
    })
  );
};

/** The id of the router's hostname map. */
const hostsId = async (): Promise<string> =>
  onlyId(
    idsOf(
      await listAll("/storage/kv/namespaces"),
      (namespace) => field(namespace, "title") === hostsTitle
    ),
    `one KV namespace ${hostsTitle} (run scripts/cloudflare-account-setup.ts first)`
  );

/** The config to deploy: the build's, if the Vite plugin wrote one. */
const configPath = (): string => {
  if (!existsSync(buildRedirect)) {
    return "wrangler.jsonc";
  }
  const target = field(
    JSON.parse(readFileSync(buildRedirect, "utf-8")),
    "configPath"
  );
  if (typeof target !== "string") {
    throw new TypeError(`${buildRedirect} names no configPath`);
  }
  return path.join(path.dirname(buildRedirect), target);
};

const config = configPath();
/**
 * A built config is the stage's already (the Vite plugin's
 * CLOUDFLARE_ENV); wrangler.jsonc picks staging with --env.
 */
const env =
  stage === "staging" && config === "wrangler.jsonc" ? "staging" : undefined;
const text = await filledConfig(
  readFileSync(config, "utf-8"),
  { storeId, hostsId, storedSecrets },
  { env, optional: optionalSecrets }
);
// Next to the config, so the paths in it (main, assets) still resolve.
const deployConfig = path.join(path.dirname(config), "wrangler.deploy.jsonc");
writeFileSync(deployConfig, text);
try {
  execFileSync(
    "wrangler",
    [
      "deploy",
      "--config",
      deployConfig,
      ...(env === undefined ? [] : ["--env", env]),
      ...wranglerArgs,
    ],
    { stdio: "inherit" }
  );
} finally {
  rmSync(deployConfig, { force: true });
}
