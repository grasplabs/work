// oxlint-disable max-classes-per-file -- the two Workflows that hold a gradual deploy's stages, each the console's with briefer sleeps
/**
 * The console as the browser journeys run it (vite.e2e.config.ts): its own
 * entry (src/server.ts) unchanged, with what the console's tests stand in
 * for around it. Never built or deployed: production runs src/server.ts.
 *
 * - Cloudflare's API, and client Workers on workers.dev, answer from the
 *   fake the tests use (test/cloudflare-api.ts), in place of `fetch` in this
 *   isolate, where the Workflows' steps run too. Requests to this machine
 *   (Vite's dev server) go out as usual; anything else is refused.
 * - Access: the dev bypass (`DEV_ACCESS_EMAIL`, src/access.ts), which holds
 *   only for requests to this machine.
 * - A rollout holds each stage of a gradual deploy for seconds, not
 *   minutes (`gradualStages`, src/rollout/workflow.ts), as the tests'
 *   `disableSleeps` does: a journey sees the stages go by.
 * - `POST /__e2e/seed` seeds what a journey starts from (test/e2e-seed.ts).
 */
import { loopbackHosts } from "@grasp-os/shared/router";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import { RolloutClient as ConsoleRolloutClient } from "../src/rollout/fleet-client.ts";
import { Rollout as ConsoleRollout } from "../src/rollout/workflow.ts";
import type {
  RolloutClientParams,
  RolloutParams,
  RolloutResult,
} from "../src/rollout/workflow.ts";
import server from "../src/server.ts";
import { base } from "./cloudflare-api-kit.ts";
import { fakeCloudflareApi } from "./cloudflare-api.ts";
import { seed } from "./e2e-seed.ts";

export { ApplyClient } from "../src/clients/apply.ts";
export { IntegrationBuild } from "../src/builds/workflow.ts";
export { ProvisionPlacedClient } from "../src/hosting/workflow.ts";
export { ProvisionClient } from "../src/provision/workflow.ts";
export { RollbackClient } from "../src/rollout/rollback.ts";

/** The tokens the fake lets in, which the seed puts in Secrets Store. */
const tokens = {
  deployer: "e2e-deployer-token",
  tenant: "e2e-tenant-admin-token",
};

type Fake = ReturnType<typeof fakeCloudflareApi>;

/**
 * The fake, one for the isolate: kept on `globalThis`, so a module Vite
 * evaluates again (its dependencies optimized on the first page) finds
 * the accounts the seed made.
 */
const fakeKey = Symbol.for("grasp-os.console-e2e.cloudflare");
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
      return await cloudflare.fetch(input, init);
    }
    if (loopbackHosts.has(url.hostname)) {
      return await outbound(input, init);
    }
    throw new Error(`Unexpected outbound request to ${url.href}`);
  };
}

/** How long a rollout holds a gradual deploy's stage in the journeys. */
const stageHold = "2 seconds";

/**
 * `step`, with every sleep `stageHold` long. Its other methods are called
 * on it as they are: `step` is an RPC stub, whose every property, `bind`
 * included, is a method of the engine's.
 */
const brief = (step: WorkflowStep): WorkflowStep =>
  new Proxy(step, {
    get: (target, property) => {
      if (property === "sleep") {
        return async (name: string) => {
          await target.sleep(name, stageHold);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });

export class Rollout extends ConsoleRollout {
  override async run(
    event: WorkflowEvent<RolloutParams>,
    step: WorkflowStep
  ): Promise<RolloutResult> {
    return await super.run(event, brief(step));
  }
}

export class RolloutClient extends ConsoleRolloutClient {
  override async run(
    event: WorkflowEvent<RolloutClientParams>,
    step: WorkflowStep
  ): Promise<void> {
    await super.run(event, brief(step));
  }
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
    return await server.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
