/**
 * Connect's Wrangler config for the e2e stack: connect's own
 * (apps/connect/wrangler.jsonc), plus the vars that send every AI
 * provider's request to the stack's fake providers (e2e/model-fake.ts),
 * so no test's request reaches a provider. They are connect's on-prem
 * relay, as plain workerd takes it (connect's src/ai-providers.ts):
 * `RUNTIME_PROFILE=workerd`, the fake's host named as the deployment's
 * own (`AI_PRIVATE_HOSTS`), and the fake as `AI_PROVIDER_ORIGIN`. Written
 * where core's dev script reads it (`CONNECT_WRANGLER_CONFIG`), as a
 * `--var` reaches core alone and local dev loads no other var of
 * connect's.
 *
 *   node e2e/connect-config.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parseJsonc } from "../scripts/jsonc.ts";
import { connectConfig, modelFakeOrigin } from "./stack.ts";

const connectDir = path.join(import.meta.dirname, "../apps/connect");

if (import.meta.main) {
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
      AI_PRIVATE_HOSTS: new URL(modelFakeOrigin).hostname,
      AI_PROVIDER_ORIGIN: modelFakeOrigin,
    },
  };
  mkdirSync(path.dirname(connectConfig), { recursive: true });
  writeFileSync(connectConfig, `${JSON.stringify(written, null, 2)}\n`);
}
