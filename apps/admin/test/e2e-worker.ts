/**
 * The admin as the browser journeys run it (vite.e2e.config.ts): its own
 * entry (src/server.ts) unchanged, with what the admin's tests stand in
 * for around it. Never built or deployed: production runs src/server.ts.
 *
 * - Cloudflare's API, and client Workers on workers.dev, answer from the
 *   fake the tests use (test/cloudflare-api.ts), in place of `fetch` in this
 *   isolate, where the runs' steps run too. Requests to this machine
 *   (Vite's dev server) go out as usual; anything else is refused.
 * - Each Worker upload takes seconds, as a real one may: a journey sees
 *   a rollout run before it's done.
 * - Access: the dev bypass (`DEV_ACCESS_EMAIL`, src/access.ts), which holds
 *   only for requests to this machine.
 * - `POST /__e2e/seed` seeds what a journey starts from,
 *   `POST /__e2e/seed-placed` the placed-client journey's,
 *   `POST /__e2e/seed-organizations` the organization sections' and
 *   `POST /__e2e/seed-create` the create journey's (test/e2e-seed.ts).
 *   `POST /__e2e/core` holds a seeded core's snapshot answer for a while,
 *   or lets it answer at once again, and answers how many snapshots it
 *   answered so far. `POST /__e2e/fault` makes one of the admin's server
 *   functions fail, or answer what its page can't show, until it is
 *   cleared.
 */
import { loopbackHosts } from "@grasp-os/shared/router";
import { toCrossJSONAsync } from "seroval";
import { z } from "zod";

import server from "../src/server.ts";
import { base } from "./cloudflare-api-kit.ts";
import type { AccountState } from "./cloudflare-api-kit.ts";
import { fakeCloudflareApi } from "./cloudflare-api.ts";
import { seed, seedCreate, seedOrganizations, seedPlaced } from "./e2e-seed.ts";

export { ChatState } from "@grasp-os/chat/state";
export { AdminRuns } from "../src/run-object.ts";

/** The tokens the fake lets in, which the seed puts in Secrets Store. */
const tokens = {
  deployer: "e2e-deployer-token",
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
const cloudflare = (held ?? fakeCloudflareApi(tokens.deployer)) as Fake;
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
    // DNS-over-HTTPS, as a create page looks up how a company signs in:
    // every domain the journeys use is on Google Workspace.
    if (url.hostname === "cloudflare-dns.com") {
      return Response.json({
        Status: 0,
        Answer: [{ type: 15, data: "1 aspmx.l.google.com." }],
      });
    }
    throw new Error(`Unexpected outbound request to ${url.href}`);
  };
}

/** The organizations seed's cores, by client, kept as the fake is. */
const coresKey = Symbol.for("grasp-os.admin-e2e.cores");
const heldCores: unknown = Reflect.get(globalThis, coresKey);
// SAFETY: only this module sets the key, to a map it made.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const cores = (heldCores ?? new Map()) as Map<string, AccountState>;
Reflect.set(globalThis, coresKey, cores);

/** What steering a seeded core takes: which, and how long it holds each answer, if that changes. */
const steerSchema = z.object({
  clientId: z.string(),
  holdMs: z.number().int().nonnegative().optional(),
});

/**
 * A seeded core, held for `holdMs` before each snapshot it answers (0
 * answers at once), and how many it answered so far.
 */
const steerCore = async (request: Request): Promise<Response> => {
  const { clientId, holdMs } = steerSchema.parse(await request.json());
  const account = cores.get(clientId);
  if (account === undefined) {
    return new Response("No such core", { status: 404 });
  }
  if (holdMs !== undefined) {
    account.adminHeld =
      holdMs === 0
        ? undefined
        : async () => {
            await scheduler.wait(holdMs);
          };
  }
  return Response.json({ reads: account.adminReaders.length });
};

/** What makes a server function fail: its name, and whether it fails or answers garbage. */
const faultSchema = z.object({
  fn: z.string().min(1).nullable(),
  mode: z.enum(["error", "garbled"]).default("error"),
});
const faultKey = Symbol.for("grasp-os.admin-e2e.fault");

/** The fault set, kept as the fake is, or null. */
const faultNow = (): z.infer<typeof faultSchema> | null => {
  const parsed = faultSchema.safeParse(Reflect.get(globalThis, faultKey));
  return parsed.success && parsed.data.fn !== null ? parsed.data : null;
};

/** Server function `id`'s name: in dev, its id is its module and export, base64url-encoded. */
const serverFnName = (id: string): string => {
  try {
    return atob(id.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return id;
  }
};

/**
 * What a server function the fault names answers: an error, or a result
 * its page can't render (a number where a list belongs). Null for any
 * other request.
 */
const faulted = async (url: URL): Promise<Response | null> => {
  const fault = faultNow();
  const [, prefix, id = ""] = url.pathname.split("/");
  if (
    fault?.fn === undefined ||
    fault.fn === null ||
    prefix !== "_serverFn" ||
    !serverFnName(id).includes(fault.fn)
  ) {
    return null;
  }
  if (fault.mode === "error") {
    return new Response("Failed, as the journey asked", { status: 500 });
  }
  return Response.json(
    await toCrossJSONAsync({ result: 42 }, { refs: new Map() }),
    { headers: { "x-tss-serialized": "true" } }
  );
};

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
    if (url.pathname === "/__e2e/seed-create" && request.method === "POST") {
      if (!loopbackHosts.has(url.hostname)) {
        return new Response("Forbidden", { status: 403 });
      }
      return Response.json(await seedCreate(cloudflare, tokens));
    }
    if (url.pathname === "/__e2e/seed-placed" && request.method === "POST") {
      if (!loopbackHosts.has(url.hostname)) {
        return new Response("Forbidden", { status: 403 });
      }
      return Response.json(await seedPlaced(cloudflare, tokens));
    }
    if (
      url.pathname === "/__e2e/seed-organizations" &&
      request.method === "POST"
    ) {
      if (!loopbackHosts.has(url.hostname)) {
        return new Response("Forbidden", { status: 403 });
      }
      const seeded = await seedOrganizations(cloudflare, tokens);
      cores.set(seeded.answered.clientId, seeded.answered.account);
      return Response.json({
        answered: seeded.answered.clientId,
        unset: seeded.unset.clientId,
      });
    }
    if (url.pathname === "/__e2e/fault" && request.method === "POST") {
      if (!loopbackHosts.has(url.hostname)) {
        return new Response("Forbidden", { status: 403 });
      }
      Reflect.set(
        globalThis,
        faultKey,
        faultSchema.parse(await request.json())
      );
      return new Response(null, { status: 204 });
    }
    const fault = await faulted(url);
    if (fault !== null) {
      return fault;
    }
    if (url.pathname === "/__e2e/core" && request.method === "POST") {
      if (!loopbackHosts.has(url.hostname)) {
        return new Response("Forbidden", { status: 403 });
      }
      return await steerCore(request);
    }
    return await server.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
