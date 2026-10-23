/**
 * The fake Cloudflare API (test/cloudflare-api.ts) in place of `fetch` for
 * each test in a file, emptied after each.
 */
import { afterEach, beforeEach, vi } from "vite-plus/test";

import { fakeCloudflareApi } from "./cloudflare-api.ts";

/**
 * A fake Cloudflare API that lets `token` (the deployer's) and
 * `tenantToken` (a tenant admin's, which alone creates accounts) in, for
 * each test in the file: it answers `fetch` in the tests' isolate, which
 * is also where the console's Workflow steps run.
 */
export const mockCloudflareApi = (
  token: string,
  tenantToken = `${token}-tenant-admin`
) => {
  const fake = fakeCloudflareApi(token, tenantToken);
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fake.reset();
  });
  return fake;
};
