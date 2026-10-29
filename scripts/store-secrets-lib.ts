/**
 * What scripts/store-secrets.ts copies from the stage's 1Password
 * Environment into the account's Secrets Store: every secret the stage's
 * platform Workers bind, under its stage's store name.
 */
import { storeSecretName } from "@grasp-os/shared/names";
import type { Stage } from "@grasp-os/shared/names";

import { parseJsonc } from "./jsonc.ts";
import { optionalSecrets } from "./optional-secrets.ts";

/** A secret a Worker binds: its binding name, as 1Password keeps it, and its store name. */
export interface SecretBinding {
  binding: string;
  storeName: string;
}

/** `value[key]` when value is an object, else undefined. */
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

/**
 * Every secret the configs `texts` (each Worker's wrangler.jsonc) bind in
 * `stage`, once each, in order: the top level's for production,
 * `env.staging`'s own for staging, as wrangler reads them.
 */
export const stageSecretBindings = (
  texts: readonly string[],
  stage: Stage
): SecretBinding[] => {
  const found = new Map<string, string>();
  for (const text of texts) {
    const config = parseJsonc(text);
    const view =
      stage === "staging" ? field(field(config, "env"), "staging") : config;
    const list = field(view, "secrets_store_secrets");
    for (const secret of Array.isArray(list) ? list : []) {
      const binding = field(secret, "binding");
      const storeName = field(secret, "secret_name");
      if (typeof binding === "string" && typeof storeName === "string") {
        found.set(binding, storeName);
      }
    }
  }
  return [...found].map(([binding, storeName]) => ({ binding, storeName }));
};

/** What a copy writes, and what stops it or it skips. */
export interface StoreSecretsPlan {
  /** Each secret to write, under its store name. */
  writes: { storeName: string; value: string }[];
  /** Required secrets `env` lacks: the copy writes nothing. */
  missing: string[];
  /** Optional secrets `env` lacks: left as the store has them. */
  skipped: string[];
}

/**
 * The copy of `bindings` from `env` (each value by binding name) in
 * `stage`. Each is written under `storeSecretName(binding, stage)`, which
 * the config's own name must be (check:wrangler-configs holds it there).
 */
export const planStoreSecrets = (
  bindings: readonly SecretBinding[],
  env: Readonly<Record<string, string | undefined>>,
  stage: Stage
): StoreSecretsPlan => {
  const plan: StoreSecretsPlan = { writes: [], missing: [], skipped: [] };
  for (const { binding, storeName } of bindings) {
    if (storeName !== storeSecretName(binding, stage)) {
      throw new Error(
        `${binding} is stored as ${storeName}, not ${storeSecretName(binding, stage)}, in ${stage}`
      );
    }
    const value = env[binding] ?? "";
    if (value !== "") {
      plan.writes.push({ storeName, value });
    } else if (optionalSecrets.has(binding)) {
      plan.skipped.push(binding);
    } else {
      plan.missing.push(binding);
    }
  }
  return plan;
};
