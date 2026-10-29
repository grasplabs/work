/**
 * scripts/platform-names.ts run as Deploy platform runs it, for the name
 * each secret is written under in the account's one Secrets Store: a
 * staging run writes only `_STAGING` names, and never one production's
 * admin or router binds (their real wrangler.jsonc).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { parseJsonc } from "./wrangler-config-rules.ts";

const root = path.join(import.meta.dirname, "..");
const script = path.join(import.meta.dirname, "platform-names.ts");

/** What the script prints for secret `name` in `stage`. */
const storeName = (stage: string, name: string): string =>
  execFileSync("node", [script, stage, "storeSecret", name], {
    encoding: "utf-8",
  }).trim();

/** `value[key]` when value is an object, else undefined. */
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

/** The bindings and store names of `bindings`, a secrets_store_secrets list. */
const secretsOf = (bindings: unknown): { binding: string; name: string }[] =>
  (Array.isArray(bindings) ? bindings : []).map((secret) => ({
    binding: String(field(secret, "binding")),
    name: String(field(secret, "secret_name")),
  }));

const configs = ["apps/admin/wrangler.jsonc", "apps/router/wrangler.jsonc"].map(
  (file) => parseJsonc(readFileSync(path.join(root, file), "utf-8"))
);
const productionNames = new Set(
  configs.flatMap((config) =>
    secretsOf(field(config, "secrets_store_secrets")).map(({ name }) => name)
  )
);
const stagingBindings = [
  ...new Set(
    configs.flatMap((config) =>
      secretsOf(
        field(field(field(config, "env"), "staging"), "secrets_store_secrets")
      ).map(({ binding }) => binding)
    )
  ),
];

describe("a secret's name in the account's Secrets Store", () => {
  it("is _STAGING for every secret a staging run writes, and none production binds", () => {
    const written = stagingBindings.map((binding) =>
      storeName("staging", binding)
    );
    expect({
      // Every secret staging binds, the shared ones Deploy platform copies among them.
      covers: [
        "ENTRA_CLIENT_SECRET",
        "MICROSOFT_CLIENT_SECRET",
        "GOOGLE_CLIENT_SECRET",
        "COMPOSIO_API_KEY",
      ].every((name) => stagingBindings.includes(name)),
      allStaging: written.every((name) => name.endsWith("_STAGING")),
      sharedWithProduction: written.filter((name) => productionNames.has(name)),
    }).toStrictEqual({
      covers: true,
      allStaging: true,
      sharedWithProduction: [],
    });
  });

  it("is the secret's own name in production", () => {
    expect(storeName("production", "ENTRA_CLIENT_SECRET")).toBe(
      "ENTRA_CLIENT_SECRET"
    );
  });
});
