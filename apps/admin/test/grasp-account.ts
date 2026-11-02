/**
 * Grasp's own account on the fake Cloudflare API (test/cloudflare-api.ts),
 * as the tests' stage has it: the namespace every client's scripts run in.
 * No test runner here: the browser journeys' worker (e2e-worker.ts) loads
 * this through its seeds, as the unit tests do.
 */
import { clientsNamespace, platformAccountId } from "@grasp-os/shared/names";

import type { AccountState, ScriptState } from "./cloudflare-api-kit.ts";
import type { fakeCloudflareApi } from "./cloudflare-api.ts";

/** The stage the tests' admin serves, as its wrangler.jsonc sets it. */
export const testStage = "production";

/**
 * Grasp's own account on `cloudflare`, with the tests' stage's clients'
 * namespace in it: where every client's scripts run.
 */
export const graspAccount = (
  cloudflare: ReturnType<typeof fakeCloudflareApi>
) => {
  const account = cloudflare.addAccount("Grasp", undefined, platformAccountId);
  if (!account.namespaces.has(clientsNamespace(testStage))) {
    account.namespaces.set(clientsNamespace(testStage), new Map());
  }
  return account;
};

/** The clients' scripts in `account`'s namespace for the tests' stage, by name. */
export const clientScripts = (
  account: AccountState
): Map<string, ScriptState> =>
  account.namespaces.get(clientsNamespace(testStage)) ??
  new Map<string, ScriptState>();
