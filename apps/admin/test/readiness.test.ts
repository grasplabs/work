/**
 * Platform's Readiness (src/admin/readiness.ts), through the admin's
 * entry, written from how onboarding fails when nobody looked first: a
 * stage or domain misset, no shared destination, no release, a
 * secret missing from Secrets Store, a deployer token that can't reach the
 * namespace, Grasp's AI on a provider it has no key for; and an optional feature left
 * unconfigured without saying so.
 */
import { clientsNamespace } from "@grasp-os/shared/names";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { fetchReadiness } from "../src/admin/readiness.ts";
import type { Readiness } from "../src/admin/readiness.ts";
import { clients, hostingDestinations, releases } from "../src/db/schema.ts";
import { setGraspClientFn } from "../src/platform-settings.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { client, db, destination } from "./hosting.ts";
import { callServerFn, page } from "./pages.ts";
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

/** Chooses `clientId` as Grasp's own organization on Platform, or none. */
const choose = async (clientId: string | null): Promise<void> => {
  await callServerFn(setGraspClientFn, { clientId });
};

/** Check `id`'s words. */
const wordsOf = ({ checks }: Readiness, id: string): string =>
  checks.find((check) => check.id === id)?.words ?? "";

describe("Platform's Readiness", () => {
  useStoreSecrets({ deployer: token });
  // The database outlives each test: each starts with no destination or
  // release, as an admin set up from nothing.
  beforeEach(async () => {
    await db.delete(hostingDestinations);
    await db.delete(releases);
  });

  it("says what stops onboarding on an admin with nothing set up, and Home says so too", async () => {
    const read = await withVars(production, readiness);
    const home = await withVars(production, async () => await page("/"));
    const platform = await withVars(
      production,
      async () => await page("/platform")
    );

    expect({
      statuses: statuses(read),
      blocking: read.blocking,
      release: wordsOf(read, "release"),
      banner: home.html.includes(
        "Grasp can&#x27;t onboard an organization yet"
      ),
      panel: platform.html.includes("No release is imported yet."),
    }).toStrictEqual({
      statuses: {
        stage: "ready",
        client_domain: "ready",
        destination: "blocked",
        release: "blocked",
        secrets: "ready",
        deployer: "waiting",
        grasp_organization: "not_configured",
      },
      blocking: 3,
      release:
        "No release is imported yet. CI publishes one for every merge to main, and the admin imports it within five minutes; Releases lists any it couldn't import, and why.",
      banner: true,
      panel: true,
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

  it("is ready once a shared destination exists, a release is imported and the deployer reaches its namespace, and Home's banner goes", async () => {
    const account = cloudflare.addAccount("Grasp clients");
    account.namespaces.set(clientsNamespace("production"), new Map());
    const destinationId = await destination({ accountId: account.id });
    await placedRelease("feat(core): ready");

    const read = await withVars(production, readiness);
    const home = await withVars(production, async () => await page("/"));

    expect({
      statuses: statuses(read),
      blocking: read.blocking,
      destination: wordsOf(read, "destination"),
      deployer: wordsOf(read, "deployer"),
      banner: home.html.includes("Grasp can&#x27;t onboard"),
    }).toMatchObject({
      statuses: {
        stage: "ready",
        client_domain: "ready",
        destination: "ready",
        release: "ready",
        secrets: "ready",
        deployer: "ready",
      },
      blocking: 0,
      destination: `New organizations are placed in ${destinationId}, Grasp's shared destination.`,
      deployer: `The deployer's token reaches ${clientsNamespace("production")} in ${destinationId}'s account.`,
      banner: false,
    });
  });

  it("blocks on a deployer token that can't reach the namespace", async () => {
    // The deployer isn't a member of this account.
    const account = cloudflare.addAccount("Not ours", "someone@else.test");
    account.namespaces.set(clientsNamespace("production"), new Map());
    await destination({ accountId: account.id });
    await placedRelease("feat(core): unreachable");

    const read = await withVars(production, readiness);

    expect({
      deployer: statuses(read).deployer,
      deployerWords: wordsOf(read, "deployer").includes(
        "The deployer's token can't reach"
      ),
    }).toStrictEqual({ deployer: "blocked", deployerWords: true });
  });

  it("checks the deployer against the one shared destination new organizations go in, of several", async () => {
    const theirs = cloudflare.addAccount("Not ours", "someone@else.test");
    theirs.namespaces.set(clientsNamespace("production"), new Map());
    const ours = cloudflare.addAccount("Grasp clients");
    ours.namespaces.set(clientsNamespace("production"), new Map());
    const unreachable = await destination({ accountId: theirs.id });
    const reachable = await destination({ accountId: ours.id });
    // The reachable one recorded first: new organizations go in it.
    await db
      .update(hostingDestinations)
      .set({ createdAt: new Date(Date.now() - 86_400_000) })
      .where(eq(hostingDestinations.id, reachable));

    const first = await withVars(production, readiness);
    // Now the unreachable one is the older: it's where they'd go.
    await db
      .update(hostingDestinations)
      .set({ createdAt: new Date(Date.now() - 2 * 86_400_000) })
      .where(eq(hostingDestinations.id, unreachable));
    const second = await withVars(production, readiness);

    expect({
      first: [statuses(first).destination, statuses(first).deployer],
      firstWords: wordsOf(first, "deployer"),
      second: [statuses(second).destination, statuses(second).deployer],
      secondWords: wordsOf(second, "deployer").includes(unreachable),
    }).toStrictEqual({
      first: ["ready", "ready"],
      firstWords: `The deployer's token reaches ${clientsNamespace("production")} in ${reachable}'s account.`,
      second: ["ready", "blocked"],
      secondWords: true,
    });
  });

  it("reads only for staff", async () => {
    await expect(
      callServerFn(fetchReadiness, undefined, { email: null })
    ).rejects.toThrow("The server function answered 403");
  });

  it("says whether Grasp's own organization is chosen, live, or gone, and not that onboarding waits on it", async () => {
    const chosen = await client();
    /** The line's status and words, as Platform reads them. */
    const line = async () => {
      const read = await withVars(production, readiness);
      return {
        status: statuses(read).grasp_organization,
        words: wordsOf(read, "grasp_organization"),
        blocking: read.blocking,
      };
    };

    await choose(null);
    const none = await line();
    await choose(chosen);
    const settingUp = await line();
    await db
      .update(clients)
      .set({ status: "active" })
      .where(eq(clients.id, chosen));
    const live = await line();
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.id, chosen));
    const gone = await line();

    expect({ none, settingUp, live, gone }).toStrictEqual({
      none: {
        status: "not_configured",
        words:
          "None is chosen, so Ask Grasp isn't set up. Choose it under Grasp's own organization on this page.",
        blocking: none.blocking,
      },
      settingUp: {
        status: "waiting",
        words: `${chosen} is chosen, and answers Ask Grasp once it's live.`,
        blocking: none.blocking,
      },
      live: {
        status: "ready",
        words: `${chosen} answers Ask Grasp.`,
        blocking: none.blocking,
      },
      gone: {
        status: "not_configured",
        words: `The one chosen (${chosen}) is gone or offboarded, so Ask Grasp isn't set up. Choose it again under Grasp's own organization on this page.`,
        blocking: none.blocking,
      },
    });
  });
});
