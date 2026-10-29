/**
 * The admin as the browser journeys run it (vite.e2e.config.ts): its own
 * entry (src/server.ts) unchanged, with what the admin's tests stand in
 * for around it. Never built or deployed: production runs src/server.ts.
 *
 * - Cloudflare's API, and client Workers on workers.dev, answer from the
 *   fake the tests use (test/cloudflare-api.ts), in place of `fetch` in this
 *   isolate, where the Workflows' steps run too. Requests to this machine
 *   (Vite's dev server) go out as usual; anything else is refused.
 * - Each Worker upload takes seconds, as a real one may: a journey sees
 *   a rollout run before it's done.
 * - Access: the dev bypass (`DEV_ACCESS_EMAIL`, src/access.ts), which holds
 *   only for requests to this machine.
 * - `POST /__e2e/seed` seeds what a journey starts from, and
 *   `POST /__e2e/seed-placed` the placed-client journey's (test/e2e-seed.ts).
 */
import { loopbackHosts } from "@grasp-os/shared/router";

import server from "../src/server.ts";
import { base } from "./cloudflare-api-kit.ts";
import { fakeCloudflareApi } from "./cloudflare-api.ts";
import { seed, seedPlaced } from "./e2e-seed.ts";

export { ChatState } from "@grasp-os/chat/state";
export { ApplyClient } from "../src/clients/apply.ts";
export { RolloutClient } from "../src/rollout/fleet-client.ts";
export { RollbackClient } from "../src/rollout/rollback.ts";
export { AdminRuns } from "../src/run-object.ts";
export { Rollout } from "../src/rollout/workflow.ts";

/** The tokens the fake lets in, which the seed puts in Secrets Store. */
const tokens = {
  deployer: "e2e-deployer-token",
  tenant: "e2e-tenant-admin-token",
};

type Fake = ReturnType<typeof fakeCloudflareApi>;

/** How long the fake takes to answer a Worker's upload in the journeys. */
const uploadMs = 2000;

/** A Worker script's upload to the fake: a PUT of the script itself. */
const isUpload = (url: URL, init: RequestInit | undefined): boolean =>
  init?.method === "PUT" && /\/scripts\/[^/]+$/u.test(url.pathname);

/**
 * The fake, one for the isolate: kept on `globalThis`, so a module Vite
 * evaluates again (its dependencies optimized on the first page) finds
 * the accounts the seed made.
 */
const fakeKey = Symbol.for("grasp-os.admin-e2e.cloudflare");
const held: unknown = Reflect.get(globalThis, fakeKey);
// SAFETY: only this module sets the key, to a fake it made.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const cloudflare = (held ??
  fakeCloudflareApi(tokens.deployer, tokens.tenant)) as Fake;
if (held === undefined) {
  Reflect.set(globalThis, fakeKey, cloudflare);
  const outbound = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (
      url.href.startsWith(`${base}/`) ||
      url.hostname.endsWith(".workers.dev")
    ) {
      if (isUpload(url, init)) {
        await scheduler.wait(uploadMs);
      }
      return await cloudflare.fetch(input, init);
    }
    if (loopbackHosts.has(url.hostname)) {
      return await outbound(input, init);
    }
    throw new Error(`Unexpected outbound request to ${url.href}`);
  };
}

export default {
  ...server,
  fetch: async (request: Request, env: Env) => {
    const url = new URL(request.url);
    if (url.pathname === "/__e2e/seed" && request.method === "POST") {
      if (!loopbackHosts.has(url.hostname)) {
        return new Response("Forbidden", { status: 403 });
      }
      return Response.json(await seed(cloudflare, tokens));
    }
    if (url.pathname === "/__e2e/seed-placed" && request.method === "POST") {
      if (!loopbackHosts.has(url.hostname)) {
        return new Response("Forbidden", { status: 403 });
      }
      return Response.json(await seedPlaced(cloudflare, tokens));
    }
    return await server.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
