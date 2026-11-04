/**
 * Connect's Wrangler config with every fixed AI provider's request sent to
 * one origin on this machine instead of the provider: connect's on-prem
 * relay, as plain workerd takes it (apps/connect/src/ai-providers.ts):
 * `RUNTIME_PROFILE=workerd`, the origin's host named as the deployment's
 * own (`AI_PRIVATE_HOSTS`), and the origin as `AI_PROVIDER_ORIGIN`. The
 * e2e stack sends them to its fake providers (e2e/connect-config.ts); the
 * Stephen Lab to its bridge to a Claude subscription
 * (scripts/lab/connect-config.ts). Core's dev script runs connect with
 * the file written (`CONNECT_WRANGLER_CONFIG`), as a `--var` reaches core
 * alone and local dev loads no other var of connect's.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parseJsonc } from "./jsonc.ts";

const connectDir = path.join(import.meta.dirname, "../apps/connect");

/** Writes connect's config to `target`, its providers' requests relayed to `origin`. */
export const writeRelayedConnectConfig = (
  target: string,
  origin: string
): void => {
  // SAFETY: connect's own config, an object.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const config = parseJsonc(
    readFileSync(path.join(connectDir, "wrangler.jsonc"), "utf-8")
  ) as Record<string, unknown> & {
    main: string;
    d1_databases: { migrations_dir: string }[];
    vars?: Record<string, string>;
  };
  // Its paths, made absolute, as the copy lives elsewhere.
  const written = {
    ...config,
    $schema: undefined,
    main: path.join(connectDir, config.main),
    d1_databases: config.d1_databases.map((database) => ({
      ...database,
      migrations_dir: path.join(connectDir, database.migrations_dir),
    })),
    vars: {
      ...config.vars,
      RUNTIME_PROFILE: "workerd",
      AI_PRIVATE_HOSTS: new URL(origin).hostname,
      AI_PROVIDER_ORIGIN: origin,
    },
  };
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(written, null, 2)}\n`);
};
