/**
 * Writes core's wrangler config for the e2e stack (apps/core/
 * wrangler.e2e.jsonc, not committed): core's own, with its AI binding the
 * scripted model (apps/core/test/model-worker.ts) instead of AI Gateway,
 * which `--local` doesn't reach. Only the stack's wrangler dev reads it
 * (playwright.config.ts), beside the model's own config, so no deployment
 * has a way to the model. Run as the stack starts: `node e2e/core-config.ts`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { e2eCoreConfig } from "./stack.ts";

const core = path.join(import.meta.dirname, "../apps/core");

/** Core's own AI binding: AI Gateway. */
const gatewayBinding = '"ai": { "binding": "AI", "remote": true },';
/** Core's service bindings, to which the model's is added. */
const services =
  '"services": [{ "binding": "CONNECT", "service": "grasp-os-connect" }],';
const withModel =
  '"services": [{ "binding": "CONNECT", "service": "grasp-os-connect" }, { "binding": "AI", "service": "grasp-os-e2e-model" }],';

/** `text` with `from`, found exactly once, as `to`; throws otherwise. */
const replacedOnce = (text: string, from: string, to: string): string => {
  const parts = text.split(from);
  if (parts.length !== 2) {
    throw new Error(
      `apps/core/wrangler.jsonc has ${parts.length - 1} of ${from}, not one: update e2e/core-config.ts to match it`
    );
  }
  return parts.join(to);
};

const own = readFileSync(path.join(core, "wrangler.jsonc"), "utf-8");
writeFileSync(
  path.join(core, e2eCoreConfig),
  `// Written by e2e/core-config.ts for the e2e stack: don't edit.\n${replacedOnce(
    replacedOnce(own, gatewayBinding, ""),
    services,
    withModel
  )}`
);
