/**
 * The fake Cloudflare API (test/cloudflare-api.ts) in place of `fetch` for
 * each test in a file, emptied after each, and its dispatch namespace in
 * place of the admin's `DISPATCHER`: Grasp's account's namespace for the
 * tests' stage, where every client's scripts run.
 */
import { clientsNamespace, platformAccountId } from "@grasp-os/shared/names";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vite-plus/test";

import type { AccountState, ScriptState } from "./cloudflare-api-kit.ts";
import { fakeCloudflareApi } from "./cloudflare-api.ts";

/** The stage the tests' admin serves, as its wrangler.jsonc sets it. */
export const testStage = "production";

/**
 * A fake Cloudflare API that lets `token` (the deployer's) in, for each
 * test in the file: it answers `fetch` in the tests' isolate, which
 * is also where the admin's runs' steps run.
 */
export const mockCloudflareApi = (token: string) => {
  const fake = fakeCloudflareApi(token);
  const namespace = fake.dispatcher(
    platformAccountId,
    clientsNamespace(testStage)
  );
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
    vi.spyOn(env.DISPATCHER, "get").mockImplementation(
      (name) =>
        // SAFETY: a stand-in user Worker: only `fetch`, which the admin calls.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        namespace.get(name) as Fetcher
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fake.reset();
  });
  return fake;
};

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
