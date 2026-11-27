/**
 * Platform's Readiness (src/admin/readiness.ts), through the admin's
 * entry, written from how onboarding fails when nobody looked first: a
 * stage or domain misset, no shared destination, no release, a
 * secret missing from Secrets Store, a deployer token that can't reach the
 * namespace.
 */
import { clientsNamespace, platformAccountId } from "@grasp-os/shared/names";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { fetchReadiness } from "../src/admin/readiness.ts";
import type { Readiness } from "../src/admin/readiness.ts";
import { releases } from "../src/db/schema.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { graspAccount } from "./grasp-account.ts";
import { db } from "./hosting.ts";
import { callServerFn } from "./pages.ts";
import { placedRelease } from "./placed.ts";
import { emptyStoreSecret, useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-readiness-5b8e21";
const cloudflare = mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

/** Runs `run` with the admin's vars as `vars` set them, as a deploy would. */
const withVars = async <T>(
  vars: Partial<Pick<Env, "STAGE" | "CLIENT_DOMAIN">>,
  run: () => Promise<T>
): Promise<T> => {
  const before = { ...env };
  Object.assign(env, vars);
  try {
    return await run();
  } finally {
    env.STAGE = before.STAGE;
    env.CLIENT_DOMAIN = before.CLIENT_DOMAIN;
  }
};

/** Production's own client domain, as its admin is deployed with it. */
const production = { STAGE: "production", CLIENT_DOMAIN: "ongrasp.app" };

/** The readiness, as Platform reads it for staff. */
const readiness = async (): Promise<Readiness> =>
  await callServerFn(fetchReadiness);

/** Each check's status, by its id. */
const statuses = ({ checks }: Readiness): Record<string, string> =>
  Object.fromEntries(checks.map(({ id, status }) => [id, status]));

/** Check `id`'s words. */
const wordsOf = ({ checks }: Readiness, id: string): string =>
  checks.find((check) => check.id === id)?.words ?? "";

describe("Platform's Readiness", () => {
  useStoreSecrets({ deployer: token });
  // The database outlives each test: each starts with no release, as an
  // admin set up from nothing.
  beforeEach(async () => {
    await db.delete(releases);
  });

  // What Home and Platform say of it is in src/admin/platform.test.tsx.
  it("says what stops onboarding on an admin with nothing set up", async () => {
    const read = await withVars(production, readiness);

    expect({
      statuses: statuses(read),
      blocking: read.blocking,
      release: wordsOf(read, "release"),
    }).toStrictEqual({
      statuses: {
        stage: "ready",
        client_domain: "ready",
        release: "blocked",
        secrets: "ready",
        // No account of Grasp's on the fake: the token reaches nothing.
        deployer: "blocked",
        composio: "ready",
      },
      blocking: 2,
      release:
        "No release is imported yet. CI publishes one for every merge to main, and the admin imports it within five minutes; Releases lists any it couldn't import, and why.",
    });
  });

  it("names a stage, domain or secret that's wrong, and where to fix each", async () => {
    await emptyStoreSecret(env.ROUTER_KEY, "ROUTER_KEY");

    const read = await withVars(
      { STAGE: "prod", CLIENT_DOMAIN: "elsewhere.test" },
      readiness
    );
    const staging = await withVars(
      { STAGE: "staging", CLIENT_DOMAIN: "ongrasp.app" },
      readiness
    );

    expect({
      stage: statuses(read).stage,
      stageWords: wordsOf(read, "stage"),
      domain: wordsOf(staging, "client_domain"),
      secrets: wordsOf(read, "secrets"),
    }).toStrictEqual({
      stage: "blocked",
      stageWords:
        "STAGE is unset or names no stage, so no operation runs anywhere. Set STAGE to staging or production in apps/admin/wrangler.jsonc for this stage, then run Deploy platform.",
      domain:
        "CLIENT_DOMAIN is ongrasp.app, but staging serves organizations under staging.ongrasp.app. Set CLIENT_DOMAIN to staging.ongrasp.app in apps/admin/wrangler.jsonc for this stage, then run Deploy platform.",
      secrets:
        "Secrets Store has no ROUTER_KEY, so provisioning stops at its first step. Add ROUTER_KEY to the stage's 1Password Environment, then run Deploy platform.",
    });
  });

  it("is ready once a release is imported and the deployer reaches the stage's namespace in Grasp's account", async () => {
    graspAccount(cloudflare);
    await placedRelease("feat(core): ready");

    const read = await withVars(production, readiness);

    expect({
      statuses: statuses(read),
      blocking: read.blocking,
      deployer: wordsOf(read, "deployer"),
    }).toMatchObject({
      statuses: {
        stage: "ready",
        client_domain: "ready",
        release: "ready",
        secrets: "ready",
        deployer: "ready",
      },
      blocking: 0,
      deployer: `The deployer's token reaches ${clientsNamespace("production")} in Grasp's account.`,
    });
  });

  it("blocks on a deployer token that can't reach the namespace", async () => {
    // The deployer isn't a member of Grasp's account.
    const account = cloudflare.addAccount(
      "Grasp",
      "someone@else.test",
      platformAccountId
    );
    account.namespaces.set(clientsNamespace("production"), new Map());
    await placedRelease("feat(core): unreachable");

    const read = await withVars(production, readiness);

    expect({
      deployer: statuses(read).deployer,
      deployerWords: wordsOf(read, "deployer").includes(
        "The deployer's token can't reach"
      ),
    }).toStrictEqual({ deployer: "blocked", deployerWords: true });
  });

  it("names each permission a Composio connection needs that Composio refuses the key, what to give it and where, asking with the shared key alone", async () => {
    cloudflare.composio.refused = new Set(["session_configs"]);

    const read = await withVars(production, readiness);
    cloudflare.composio.refused = new Set();
    const ready = await withVars(production, readiness);

    expect({
      composio: statuses(read).composio,
      words: wordsOf(read, "composio"),
      asked: cloudflare.composio.paths.toSorted(),
      keys: [...new Set(cloudflare.composio.keys)],
      // An optional feature: onboarding isn't held by it.
      required: read.checks.find(({ id }) => id === "composio")?.required,
      ready: statuses(ready).composio,
    }).toStrictEqual({
      composio: "blocked",
      words:
        "Composio refuses this key Session management (403), so every Composio connection fails. In Composio's dashboard, give the project a default API key, or a scoped one with Auth configs, Connected accounts and Session management each Read and write, Session tool execution Write only, and Toolkits and Tools Read only; MCP (Legacy) isn't needed, put it in the stage's 1Password Environment as COMPOSIO_API_KEY, then run Deploy platform and redeploy the organizations, so their connect gets it.",
      asked: [
        "auth_configs?limit=1",
        "auth_configs?limit=1",
        "connected_accounts?limit=1",
        "connected_accounts?limit=1",
        "session_configs?limit=1",
        "session_configs?limit=1",
      ],
      keys: ["composio-key"],
      required: false,
      ready: "ready",
    });
  });

  it("reads only for staff", async () => {
    await expect(
      callServerFn(fetchReadiness, undefined, { email: null })
    ).rejects.toThrow("The server function answered 403");
  });
});
