/**
 * Copies the platform's runtime secrets from the stage's 1Password
 * Environment, which is where every secret lives, into the account's one
 * Secrets Store, where the admin and the router read them (Deploy
 * platform, .github/workflows/deploy-platform.yml):
 *
 *   node scripts/store-secrets.ts names <staging|production>
 *   node scripts/store-secrets.ts copy <staging|production>
 *
 * `names` prints every secret the stage's admin and router bind
 * (store-secrets-lib.ts), by binding name, space-separated: the names the
 * workflow loads from 1Password, which always keeps the plain name. `copy`
 * writes each from the env under its stage's store name
 * (`storeSecretName`: `_STAGING` appended in staging), so a staging run
 * never writes a secret production reads. A required one the env lacks
 * stops it before anything is written, naming them all; an optional one it
 * lacks is skipped, and one the store already has is left as it is.
 *
 * Values go to the API in a request body, never to argv or a log line, and
 * are written every run: Secrets Store never reads a value back to compare.
 *
 * Env for `copy`: CLOUDFLARE_API_TOKEN, and each secret by binding name.
 * CLOUDFLARE_API_URL (tests only) replaces the API's base URL.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  platformAccountId,
  platformSecretsStoreId,
  stageNamed,
} from "@grasp-os/shared/names";

import { planStoreSecrets, stageSecretBindings } from "./store-secrets-lib.ts";

const root = path.join(import.meta.dirname, "..");
/** The platform Workers whose Secrets Store bindings the copy fills. */
const configs = ["apps/admin/wrangler.jsonc", "apps/router/wrangler.jsonc"];

const [command, stageArg] = process.argv.slice(2);
const stage = stageNamed(stageArg);
if (stage === undefined || (command !== "names" && command !== "copy")) {
  throw new Error(
    "Usage: node scripts/store-secrets.ts <names|copy> <staging|production>"
  );
}

const bindings = stageSecretBindings(
  configs.map((file) => readFileSync(path.join(root, file), "utf-8")),
  stage
);

/** `value[key]` when value is an object, else undefined. */
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

const api = (
  process.env.CLOUDFLARE_API_URL ?? "https://api.cloudflare.com/client/v4"
).replace(/\/$/u, "");
const storeUrl = `${api}/accounts/${platformAccountId}/secrets_store/stores/${platformSecretsStoreId}/secrets`;

/** A Cloudflare API call with the job's token, its JSON result, or an error naming what failed. */
const call = async (
  url: string,
  init: { method?: string; body?: unknown } = {}
): Promise<unknown> => {
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  if (token === "") {
    throw new Error("CLOUDFLARE_API_TOKEN is not set");
  }
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!response.ok) {
    // The status alone: an error body could echo what was sent.
    throw new Error(
      `Secrets Store ${init.method ?? "GET"}: HTTP ${response.status}`
    );
  }
  return await response.json();
};

/** The store's secrets, by name, with their ids, page by page. */
const storedIds = async (): Promise<Map<string, string>> => {
  const ids = new Map<string, string>();
  for (let page = 1; ; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const body = await call(`${storeUrl}?per_page=100&page=${page}`);
    const result = field(body, "result");
    for (const secret of Array.isArray(result) ? result : []) {
      const name = field(secret, "name");
      const id = field(secret, "id");
      if (typeof name === "string" && typeof id === "string") {
        ids.set(name, id);
      }
    }
    const totalPages = Number(
      field(field(body, "result_info"), "total_pages") ?? 1
    );
    if (!Array.isArray(result) || page >= totalPages) {
      return ids;
    }
  }
};

if (command === "names") {
  console.log(bindings.map(({ binding }) => binding).join(" "));
} else {
  const plan = planStoreSecrets(bindings, process.env, stage);
  if (plan.missing.length > 0) {
    throw new Error(
      `Empty in the ${stage} 1Password Environment, nothing written: ${plan.missing.join(", ")}`
    );
  }
  const ids = await storedIds();
  for (const { storeName, value } of plan.writes) {
    const id = ids.get(storeName);
    // oxlint-disable-next-line no-await-in-loop -- one secret at a time
    await (id === undefined
      ? call(storeUrl, {
          method: "POST",
          body: [{ name: storeName, value, scopes: ["workers"] }],
        })
      : call(`${storeUrl}/${id}`, { method: "PATCH", body: { value } }));
  }
  console.info(
    `Secrets Store: ${plan.writes.map(({ storeName }) => storeName).join(", ")} written${
      plan.skipped.length > 0
        ? `; not in 1Password, so left as they are: ${plan.skipped.join(", ")}`
        : ""
    }`
  );
}
