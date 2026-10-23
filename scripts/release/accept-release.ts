/**
 * Staging's acceptance of a release deployed from its own bytes
 * (deploy-release.ts): core's `/health` on its workers.dev origin must
 * answer as the version that deploy just made live, to a request carrying
 * the router secret as the router sends it. The console's smoke check for
 * a client deploy (apps/console/src/deploy/router.ts) asks the same: so
 * the version answering is the one deployed, and it has the secret the
 * router will send. Tries a few times, waiting longer between them: the
 * previous version can answer for a moment after a deploy.
 *
 * A release is published for the console only once this passes
 * (publish-release in .github/workflows/ci.yml).
 *
 * Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (for the account's
 *      workers.dev subdomain), ROUTER_SECRET (core's)
 * Usage: vp run release:accept --release <dir> --version <version id>
 */
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { routerSecretHeader } from "@grasp-os/shared/router";
import { z } from "zod";

import { workerOf } from "./deploy-lib.ts";
import { verifyRelease } from "./manifest-lib.ts";

/** The app whose health is the release's acceptance. */
const ACCEPTED_APP = "core";
const ATTEMPTS = 6;
const FIRST_RETRY_MS = 2000;
const ATTEMPT_TIMEOUT_MS = 10_000;

const { values: args } = parseArgs({
  options: {
    release: { type: "string" },
    version: { type: "string" },
  },
});
if (args.release === undefined || args.version === undefined) {
  throw new Error("--release <dir> and --version <version id> are required");
}
const expectedVersion = args.version;

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
};

/** What the Workers API answers for the account's workers.dev subdomain. */
const subdomainAnswer = z.object({
  result: z.object({ subdomain: z.string().regex(/^[a-z0-9-]+$/u) }),
});

/** What core's `/health` answers (core's src/entry.ts). */
const healthAnswer = z.object({ ok: z.literal(true), version: z.string() });

const workersSubdomain = async (): Promise<string> => {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${requireEnv("CLOUDFLARE_ACCOUNT_ID")}/workers/subdomain`,
    {
      headers: {
        authorization: `Bearer ${requireEnv("CLOUDFLARE_API_TOKEN")}`,
      },
    }
  );
  if (!response.ok) {
    throw new Error(
      `Reading the account's workers.dev subdomain: HTTP ${response.status}`
    );
  }
  return subdomainAnswer.parse(await response.json()).result.subdomain;
};

/** The version core at `origin` answers as; undefined when it doesn't answer so. */
const answeringVersion = async (
  origin: string,
  routerSecret: string
): Promise<string | undefined> => {
  try {
    const response = await fetch(`${origin}/health`, {
      headers: { [routerSecretHeader]: routerSecret },
      redirect: "manual",
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
    if (!response.ok) {
      return undefined;
    }
    const health = healthAnswer.safeParse(await response.json());
    return health.success ? health.data.version : undefined;
  } catch {
    return undefined;
  }
};

// The release names core's Worker, so the check asks the Worker that was
// deployed from it.
const { manifest } = await verifyRelease(path.resolve(args.release));
const core = workerOf(manifest, ACCEPTED_APP);
const origin = `https://${core.name}.${await workersSubdomain()}.workers.dev`;
const routerSecret = requireEnv("ROUTER_SECRET");

let answering: string | undefined;
for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  // oxlint-disable-next-line no-await-in-loop -- tries in turn
  answering = await answeringVersion(origin, routerSecret);
  if (answering === expectedVersion) {
    console.info(
      `${origin} answers as version ${expectedVersion} of release ${manifest.releaseId} (try ${attempt})`
    );
    break;
  }
  if (attempt < ATTEMPTS) {
    // oxlint-disable-next-line no-await-in-loop -- waits between tries
    await sleep(FIRST_RETRY_MS * 2 ** (attempt - 1));
  }
}
if (answering !== expectedVersion) {
  throw new Error(
    `${origin} didn't answer as version ${expectedVersion} (last: ${answering ?? "no answer"}); release ${manifest.releaseId} not accepted`
  );
}
