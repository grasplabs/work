/**
 * What scripts/store-secrets.ts copies from the stage's 1Password
 * Environment into the account's Secrets Store: every secret the stage's
 * platform Workers bind, under its stage's store name.
 */
import { scryptSync } from "node:crypto";

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
  /** Each secret to write, by binding name and under its store name. */
  writes: { binding: string; storeName: string; value: string }[];
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
      plan.writes.push({ binding, storeName, value });
    } else if (optionalSecrets.has(binding)) {
      plan.skipped.push(binding);
    } else {
      plan.missing.push(binding);
    }
  }
  return plan;
};

/**
 * The keys the admin derives or seals with, by binding name, which a copy
 * creates but never replaces. Each client's router secret is derived from
 * `ROUTER_KEY`, so a new one leaves the router unable to reach any core
 * until every client is redeployed; each client's other secrets are
 * derived from `CLIENT_KEY`, and the Teams and Slack secrets in the
 * admin's database are sealed under it, so a new one makes those
 * unreadable for good. Changing either is a rotation: a procedure of its
 * own, never a side effect of a copy. `DEPLOYER_API_TOKEN` is not one:
 * nothing is derived from it, so a new token simply replaces the old.
 */
export const masterKeys: ReadonlySet<string> = new Set([
  "ROUTER_KEY",
  "CLIENT_KEY",
]);

/** What every master key's fingerprint starts with, in its comment. */
export const fingerprintPrefix = "grasp-fingerprint:scrypt:";

/** Bytes in a fingerprint. */
const fingerprintLength = 32;

/**
 * The fingerprint a master key's value is known by, kept as the secret's
 * comment. Secrets Store never reads a value back, so a copy can only
 * tell whether 1Password still holds the store's value by comparing
 * something derived from it; the comment is the one field the API keeps
 * with the secret, on create and on update, and lists back with it, so
 * the fingerprint lives and dies with the secret, and no marker elsewhere
 * can drift from it. Anyone who can list the store sees comments, so it
 * is scrypt, salted with the secret's store name: one value has unrelated
 * fingerprints under two names (staging's and production's), and guessing
 * a value from its fingerprint costs a scrypt per guess.
 */
export const fingerprintOf = (storeName: string, value: string): string => {
  const derived = scryptSync(
    value,
    `grasp-store-secrets:${storeName}`,
    fingerprintLength
  );
  return `${fingerprintPrefix}${derived.toString("hex")}`;
};

/** A secret the store already has: its id, and its comment. */
export interface StoredSecret {
  id: string;
  comment: string;
}

/** One call a copy makes to the store. */
export type StoreWrite =
  | { kind: "create"; storeName: string; value: string; comment: string }
  | { kind: "update"; storeName: string; id: string; value: string }
  | { kind: "fingerprint"; storeName: string; id: string; comment: string };

/** The calls a copy makes, and the master keys that stop it. */
export interface StoreWritesPlan {
  writes: StoreWrite[];
  /** Master keys the store holds with another value than 1Password's. */
  mismatched: string[];
  /** Master keys the store held with no fingerprint, now given 1Password's. */
  adopted: string[];
}

/**
 * The calls that bring the store to `plan`, given what it has (`stored`,
 * by store name).
 *
 * An ordinary secret is created or updated. A master key is created with
 * its fingerprint as its comment when the store lacks it, and otherwise
 * never written: the same fingerprint means 1Password and the store
 * agree; another one means they don't, which stops the copy before
 * anything is written. One the store holds with no fingerprint (put there
 * before copies kept one) is trusted on first use: its value stays, and
 * 1Password's fingerprint becomes its comment, so the next copy compares.
 */
export const planStoreWrites = (
  plan: StoreSecretsPlan,
  stored: ReadonlyMap<string, StoredSecret>
): StoreWritesPlan => {
  const result: StoreWritesPlan = { writes: [], mismatched: [], adopted: [] };
  for (const { binding, storeName, value } of plan.writes) {
    const existing = stored.get(storeName);
    const fingerprint = masterKeys.has(binding)
      ? fingerprintOf(storeName, value)
      : undefined;
    if (fingerprint === undefined) {
      result.writes.push(
        existing === undefined
          ? { kind: "create", storeName, value, comment: "" }
          : { kind: "update", storeName, id: existing.id, value }
      );
    } else if (existing === undefined) {
      result.writes.push({
        kind: "create",
        storeName,
        value,
        comment: fingerprint,
      });
    } else if (!existing.comment.startsWith(fingerprintPrefix)) {
      result.adopted.push(storeName);
      result.writes.push({
        kind: "fingerprint",
        storeName,
        id: existing.id,
        comment: fingerprint,
      });
    } else if (existing.comment !== fingerprint) {
      result.mismatched.push(storeName);
    }
  }
  return result;
};
