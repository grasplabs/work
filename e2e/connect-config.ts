/**
 * Connect's Wrangler config for the e2e stack: connect's own
 * (apps/connect/wrangler.jsonc), plus the vars that send every AI
 * provider's request to the stack's fake providers (e2e/model-fake.ts),
 * so no test's request reaches a provider (scripts/connect-relay-config.ts).
 * Written where core's dev script reads it (`CONNECT_WRANGLER_CONFIG`).
 *
 *   node e2e/connect-config.ts
 */
import { writeRelayedConnectConfig } from "../scripts/connect-relay-config.ts";
import { connectConfig, modelFakeOrigin } from "./stack.ts";

if (import.meta.main) {
  writeRelayedConnectConfig(connectConfig, modelFakeOrigin);
}
