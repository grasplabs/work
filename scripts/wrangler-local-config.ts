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
 * For the same reason connect saw none of its optional secrets: a key in
 * its `.dev.vars` that the config doesn't require (COMPOSIO_API_KEY, the
 * AI providers' keys) never reached it, so Composio was never offered
 * locally. The local config requires every secret its `.dev.vars` sets
 * that isn't a var. Only the names go into it, never a value.
 *
 * With `CONNECT_DEV_MAIN` set, the local config's `main` is that file
 * instead of the Worker's own: `vp run dev` (scripts/dev.ts) names
 * connect's test/dev-entry.ts, which is connect with a fake outside API
 * beside it. An environment variable of this script's, read on a
 * developer's machine: no Worker reads it, and a deployment is rendered
 * from wrangler.jsonc, never from the local config.
 *
 * Usage: `node scripts/wrangler-local-config.ts <config> NAME:value...`
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

import { parseJsonc } from "./jsonc.ts";

const leadingBom = /^\uFEFF/u;

/**
 * The secrets `config` requires, and every other key `devVars` sets that
 * isn't one of its `vars`: wrangler loads a var's value from `.dev.vars`
 * already, and refuses a name that is both a var and a secret. It refuses
 * one shared with any other binding too (connect's DB, CLOCK, LOADER,
 * CF_VERSION_METADATA): such a name in `.dev.vars` stops local dev with
 * wrangler's own message.
 *
 * Wrangler reads `.dev.vars` with dotenv, which isn't a dependency here;
 * Node's parser lists the same keys once a leading BOM is gone, except a
 * `KEY: value` line, which wrangler loads and this leaves unbound, and a
 * name with a space, which this lists and wrangler warns is missing.
 */
const requiredSecrets = (
  config: object,
  vars: object,
  devVars: string | undefined
): string[] => {
  const secrets: unknown = Reflect.get(config, "secrets");
  const required: unknown =
    typeof secrets === "object" && secrets !== null
      ? Reflect.get(secrets, "required")
      : undefined;
  const named = Array.isArray(required)
    ? required.filter((name) => typeof name === "string")
    : [];
  const set =
    devVars === undefined
      ? []
      : Object.keys(parseEnv(devVars.replace(leadingBom, ""))).filter(
          (name) => !Object.hasOwn(vars, name)
        );
  return [...new Set([...named, ...set])];
};

/**
 * The local config for `config`: `added` among its vars, `main` swapped
 * for `devMain` when there is one, and every secret `devVars` (the text of
 * the `.dev.vars` beside it, if there is one) sets required.
 */
export const localConfig = (
  config: object,
  {
    added,
    devMain,
    devVars,
  }: {
    added: Record<string, string>;
    devMain: string | undefined;
    devVars: string | undefined;
  }
): object => {
  const own: unknown = Reflect.get(config, "vars");
  const vars = { ...(typeof own === "object" ? own : {}), ...added };
  return {
    ...config,
    ...(devMain === undefined ? {} : { main: devMain }),
    vars,
    secrets: { required: requiredSecrets(config, vars, devVars) },
  };
};

if (import.meta.main) {
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
  const devVarsPath = path.join(path.dirname(config), ".dev.vars");
  const local = localConfig(parsed, {
    added,
    // Never for a stack that brings a config of its own, as the e2e stack
    // does (`CONNECT_WRANGLER_CONFIG`): a variable left in a shell can't
    // swap the connect its tests run against.
    devMain:
      process.env.CONNECT_WRANGLER_CONFIG === undefined
        ? process.env.CONNECT_DEV_MAIN
        : undefined,
    devVars: existsSync(devVarsPath)
      ? readFileSync(devVarsPath, "utf-8")
      : undefined,
  });

  // Next to the config, so every path in it still resolves the same.
  writeFileSync(
    path.join(path.dirname(config), "wrangler.local.jsonc"),
    `${JSON.stringify(local, null, 2)}\n`
  );
}
