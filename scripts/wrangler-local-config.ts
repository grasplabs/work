/**
 * Writes `wrangler.local.jsonc` next to a Worker's wrangler config: the
 * same config with the vars given as `NAME:value` added, for local
 * `wrangler dev` only (gitignored, like wrangler.deploy.jsonc).
 *
 * Core's `dev` runs connect as wrangler's second Worker, and wrangler
 * gives a `--var` to the first Worker alone; for any other it loads
 * `.dev.vars` and the environment only for a var its config already names
 * or a required secret. So connect never saw the local profile's
 * `DURABLE_OBJECT_JURISDICTION=none` and asked workerd for the EU
 * jurisdiction, which workerd doesn't implement: its clock failed every
 * minute. The var can't go in wrangler.jsonc, as a deployment's
 * jurisdiction is set only by the admin's rendering (unset is the EU), so
 * the local config carries it instead.
 *
 * Usage: `node scripts/wrangler-local-config.ts <config> NAME:value...`
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parseJsonc } from "./jsonc.ts";

const [config, ...pairs] = process.argv.slice(2);
if (config === undefined || pairs.length === 0) {
  throw new Error("Usage: wrangler-local-config.ts <config> NAME:value...");
}

const parsed = parseJsonc(readFileSync(config, "utf-8"));
if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
  throw new Error(`${config} is not a wrangler config`);
}

const added = Object.fromEntries(
  pairs.map((pair) => {
    const at = pair.indexOf(":");
    if (at <= 0) {
      throw new Error(`${pair} is not NAME:value`);
    }
    return [pair.slice(0, at), pair.slice(at + 1)];
  })
);
const vars: unknown = Reflect.get(parsed, "vars");
const local = {
  ...parsed,
  vars: { ...(typeof vars === "object" ? vars : {}), ...added },
};

// Next to the config, so every path in it still resolves the same.
writeFileSync(
  path.join(path.dirname(config), "wrangler.local.jsonc"),
  `${JSON.stringify(local, null, 2)}\n`
);
