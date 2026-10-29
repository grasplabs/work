/**
 * Platform's Readiness: whether this admin can onboard an organization
 * now, one check a line, each with a plain status and what to do next.
 * Every check reads what the admin reads when it acts (its vars, Secrets
 * Store, its destinations and releases, the Cloudflare API as the
 * deployer), so a red line is the reason the action would fail, before
 * anyone tries it. Required lines that aren't ready put a banner on Home.
 *
 * Nothing secret leaves here: a secret is named, never its value, and an
 * API failure is its code.
 */
import {
  clientDomain as stageDomain,
  stageNamed,
} from "@grasp-os/shared/names";
import { releaseManifestSchema } from "@grasp-os/shared/release";
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { count, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { ifStored } from "../clients/grid.ts";
import { adminDatabase } from "../db/act.ts";
import { hostingDestinations, releases } from "../db/schema.ts";
import { clientDomain, deployerApi, storeSecret } from "../deploy/context.ts";
import { errorCode } from "../deploy/errors.ts";
import { discordWebhookOf } from "../discord-webhook.ts";
import { automaticChoice, destinationChoices } from "../hosting/placement.ts";
import type { DestinationChoice } from "../hosting/placement.ts";
import type { HostingPolicyId } from "../hosting/policy.ts";
import { staffIds } from "./discord.ts";

/**
 * How a check stands:
 * - `ready`: nothing to do;
 * - `blocked`: something to fix before an organization can be onboarded
 *   (or, for an optional check, before that feature works);
 * - `waiting`: it can't be checked until a line above it is ready;
 * - `not_configured`: an optional feature that isn't set up.
 */
export type CheckStatus = "ready" | "blocked" | "waiting" | "not_configured";

/** Where a check's next step is done in the admin, when it's done there. */
export type CheckLink = "releases" | "platform" | "organizations";

/** One line of the checklist. */
export interface ReadinessCheck {
  id: string;
  title: string;
  /** Whether onboarding an organization needs it; an optional one is a feature. */
  required: boolean;
  status: CheckStatus;
  /** What stands, in plain words, then what to do next when there's something to do. */
  words: string;
  link?: CheckLink;
}

/** The checklist, and whether every required line is ready. */
export interface Readiness {
  checks: ReadinessCheck[];
  /** The required lines that aren't ready. */
  blocking: number;
}

/** The policy every new organization is placed under today. */
const policyId: HostingPolicyId = "eu-storage";

/** A step that ends at Deploy platform, for a var in apps/admin/wrangler.jsonc. */
const varStep = (names: string): string =>
  `Set ${names} in apps/admin/wrangler.jsonc for this stage, then run Deploy platform.`;

/** A step that ends at Deploy platform, for secrets. */
const secretStep = (names: readonly string[]): string =>
  `Add ${names.join(", ")} to the stage's 1Password Environment, then run Deploy platform.`;

/** The Secrets Store secrets a provisioning reads: none may be missing. */
const requiredSecrets = [
  "DEPLOYER_API_TOKEN",
  "ROUTER_KEY",
  "CLIENT_KEY",
  "ENTRA_CLIENT_SECRET",
  "MICROSOFT_CLIENT_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "COMPOSIO_API_KEY",
] as const;

/** How long the deployer's call may take before the check says it couldn't tell. */
const reachTimeoutMs = 5000;

/** A Discord application's public key: 32 bytes, hex. */
const publicKeyPattern = /^[0-9a-f]{64}$/iu;

const stageCheck = (envOf: Env): ReadinessCheck => {
  const stage = stageNamed(envOf.STAGE);
  return stage === undefined
    ? {
        id: "stage",
        title: "Stage",
        required: true,
        status: "blocked",
        words: `STAGE is unset or names no stage, so no operation runs anywhere. ${varStep("STAGE to staging or production")}`,
      }
    : {
        id: "stage",
        title: "Stage",
        required: true,
        status: "ready",
        words: `This admin serves ${stage}.`,
      };
};

const domainCheck = (envOf: Env): ReadinessCheck => {
  const domain = clientDomain(envOf);
  const stage = stageNamed(envOf.STAGE);
  const expected = stage === undefined ? null : stageDomain(stage);
  if (domain === null) {
    return {
      id: "client_domain",
      title: "Client domain",
      required: true,
      status: "blocked",
      words: `CLIENT_DOMAIN isn't set, so no organization has a hostname. ${varStep(`CLIENT_DOMAIN${expected === null ? "" : ` to ${expected}`}`)}`,
    };
  }
  if (expected !== null && domain !== expected) {
    return {
      id: "client_domain",
      title: "Client domain",
      required: true,
      status: "blocked",
      words: `CLIENT_DOMAIN is ${domain}, but ${stage} serves organizations under ${expected}. ${varStep(`CLIENT_DOMAIN to ${expected}`)}`,
    };
  }
  return {
    id: "client_domain",
    title: "Client domain",
    required: true,
    status: "ready",
    words: `Organizations are served as <id>.${domain}.`,
  };
};

/** What keeps `choice` from taking an organization, in a few words. */
const problemsOf = ({ id, problems }: DestinationChoice): string =>
  `${id} (${problems.length} ${problems.length === 1 ? "requirement" : "requirements"} not met)`;

const destinationCheck = (choices: DestinationChoice[]): ReadinessCheck => {
  const automatic = automaticChoice(choices);
  if (automatic.destinationId !== null) {
    return {
      id: "destination",
      title: "Hosting destination",
      required: true,
      status: "ready",
      words: `New organizations are placed in ${automatic.destinationId}, which meets every requirement of ${policyId}.`,
    };
  }
  if (automatic.reason === "several") {
    return {
      id: "destination",
      title: "Hosting destination",
      required: true,
      status: "ready",
      words: `Several shared destinations meet ${policyId}: choose one on each organization's Setup.`,
      link: "organizations",
    };
  }
  const shared = choices.filter((choice) => choice.shared);
  return {
    id: "destination",
    title: "Hosting destination",
    required: true,
    status: "blocked",
    words:
      shared.length === 0
        ? `There's no shared destination to place organizations in. Register the stage's Workers for Platforms namespace as a destination.`
        : `No shared destination meets every requirement of ${policyId}: ${shared.map(problemsOf).join(", ")}. Each organization's Setup lists what each one misses; record the evidence for each requirement.`,
    link: "organizations",
  };
};

/** The newest imported release's manifest; null before any. */
const newestManifest = async (envOf: Env) => {
  const [row] = await adminDatabase(envOf.DB)
    .select({ manifest: releases.manifest })
    .from(releases)
    .orderBy(desc(releases.builtAt))
    .limit(1);
  if (row === undefined) {
    return null;
  }
  const parsed = releaseManifestSchema.safeParse(JSON.parse(row.manifest));
  return parsed.success ? parsed.data : null;
};

const releaseCheck = (
  imported: number,
  newest: string | null
): ReadinessCheck =>
  imported === 0 || newest === null
    ? {
        id: "release",
        title: "Imported release",
        required: true,
        status: "blocked",
        words:
          "No release is imported yet. CI publishes one for every merge to main, and the admin imports it within five minutes; Releases lists any it couldn't import, and why.",
        link: "releases",
      }
    : {
        id: "release",
        title: "Imported release",
        required: true,
        status: "ready",
        words: `${imported} ${imported === 1 ? "release is" : "releases are"} imported, the newest ${newest}.`,
        link: "releases",
      };

/**
 * Model spend (GRA-141): the provisioning operation refuses any Worker
 * that binds Workers AI until a spend ceiling and the shared AI Gateway
 * are decided (`model_spend_undecided`, src/hosting/operation.ts). This
 * reads the newest release as the operation would: blocked while it binds
 * Workers AI. Change it with the operation's check.
 */
const modelSpendCheck = (
  manifest: Awaited<ReturnType<typeof newestManifest>>
): ReadinessCheck => {
  if (manifest === null) {
    return {
      id: "model_spend",
      title: "Model spend",
      required: true,
      status: "waiting",
      words: "Checked once a release is imported.",
    };
  }
  const binds = Object.values(manifest.workers).some((worker) =>
    worker.bindings.some(({ type }) => type === "ai")
  );
  return binds
    ? {
        id: "model_spend",
        title: "Model spend",
        required: true,
        status: "blocked",
        words:
          "The newest release binds Workers AI, which placed organizations don't get until a model spend ceiling and the shared AI Gateway are decided (GRA-141). No organization can be provisioned until then: decide GRA-141.",
      }
    : {
        id: "model_spend",
        title: "Model spend",
        required: true,
        status: "ready",
        words: "The newest release binds no Workers AI.",
      };
};

/** The names of `names` Secrets Store doesn't have. */
const missingSecrets = async (
  envOf: Env,
  names: readonly (typeof requiredSecrets)[number][]
): Promise<string[]> => {
  const read = await Promise.all(
    names.map(async (name) => ({
      name,
      value: await ifStored(async () => await storeSecret(envOf, name)),
    }))
  );
  return read.filter(({ value }) => value === null).map(({ name }) => name);
};

const secretsCheck = (missing: string[]): ReadinessCheck =>
  missing.length === 0
    ? {
        id: "secrets",
        title: "Secrets",
        required: true,
        status: "ready",
        words: "Every secret a provisioning reads is in Secrets Store.",
      }
    : {
        id: "secrets",
        title: "Secrets",
        required: true,
        status: "blocked",
        words: `Secrets Store has no ${missing.join(", ")}, so provisioning stops at its first step. ${secretStep(missing)}`,
      };

/**
 * Whether the deployer's token reaches the destination new organizations
 * go in: its Workers for Platforms namespace, read as the deployer.
 */
/** The deployer check, waiting for a line above it, saying for which. */
const deployerWaiting = (words: string): ReadinessCheck => ({
  id: "deployer",
  title: "Deployer token",
  required: true,
  status: "waiting",
  words,
});

/** Whether the deployer reaches destination `id`'s namespace: null when it does, else why not. */
const reachOf = async (
  envOf: Env,
  id: string
): Promise<{
  id: string;
  namespace: string | null;
  problem: string | null;
}> => {
  const destination = await adminDatabase(envOf.DB)
    .select()
    .from(hostingDestinations)
    .where(eq(hostingDestinations.id, id))
    .get();
  const accountId = destination?.accountId ?? null;
  const namespace = destination?.namespace ?? null;
  if (accountId === null || namespace === null) {
    return { id, namespace, problem: "no account and namespace recorded" };
  }
  try {
    const api = await deployerApi(envOf, {
      waitBudgetMs: 0,
      signal: AbortSignal.timeout(reachTimeoutMs),
    });
    await api.call(
      {
        method: "GET",
        path: `/accounts/${accountId}/workers/dispatch/namespaces/${encodeURIComponent(namespace)}`,
      },
      z.unknown()
    );
    return { id, namespace, problem: null };
  } catch (error) {
    return { id, namespace, problem: errorCode(error) };
  }
};

/**
 * Whether the deployer's token reaches a destination new organizations
 * can go in: each eligible one's Workers for Platforms namespace, read as
 * the deployer. Ready when any is reached, since staff can choose that one
 * on an organization's Setup.
 */
const deployerCheck = async (
  envOf: Env,
  destinationIds: readonly string[],
  tokenMissing: boolean
): Promise<ReadinessCheck> => {
  if (tokenMissing) {
    return deployerWaiting(
      "Checked once DEPLOYER_API_TOKEN is in Secrets Store."
    );
  }
  if (destinationIds.length === 0) {
    return deployerWaiting(
      "Checked once a destination takes new organizations."
    );
  }
  const reaches = await Promise.all(
    destinationIds.map(async (id) => await reachOf(envOf, id))
  );
  const reached = reaches.find(({ problem }) => problem === null);
  if (reached !== undefined) {
    return {
      id: "deployer",
      title: "Deployer token",
      required: true,
      status: "ready",
      words: `The deployer's token reaches ${reached.namespace ?? ""} in ${reached.id}'s account.`,
    };
  }
  return {
    id: "deployer",
    title: "Deployer token",
    required: true,
    status: "blocked",
    words: `The deployer's token can't reach ${reaches.map(({ id, problem }) => `${id} (${problem ?? ""})`).join(", ")}. Give the token Workers for Platforms edit on that account, or put the right one in the stage's 1Password Environment as DEPLOYER_API_TOKEN, then run Deploy platform.`,
  };
};

const alertsCheck = async (envOf: Env): Promise<ReadinessCheck> => {
  const stored = await ifStored(
    async () => await storeSecret(envOf, "STAFF_ALERTS_WEBHOOK")
  );
  if (stored !== null && discordWebhookOf(stored) !== null) {
    return {
      id: "alerts",
      title: "Alerts channel",
      required: false,
      status: "ready",
      words: "Staff alerts are posted to the Discord channel.",
    };
  }
  return {
    id: "alerts",
    title: "Alerts channel",
    required: false,
    status: "not_configured",
    words: `${stored === null ? "No alerts channel is set" : "STAFF_ALERTS_WEBHOOK isn't a Discord webhook"}, so staff alerts aren't posted to Discord. ${secretStep(["STAFF_ALERTS_WEBHOOK"])}`,
  };
};

const roomsCheck = async (envOf: Env): Promise<ReadinessCheck> => {
  const origin = envOf.ROOMS_ORIGIN ?? "";
  const token = await ifStored(
    async () => await storeSecret(envOf, "ROOMS_READ_TOKEN")
  );
  const steps = [
    ...(origin.startsWith("https://")
      ? []
      : [
          `ROOMS_ORIGIN isn't set. ${varStep("ROOMS_ORIGIN to Rooms' https origin")}`,
        ]),
    ...(token === null
      ? [
          `ROOMS_READ_TOKEN isn't in Secrets Store. ${secretStep(["ROOMS_READ_TOKEN"])}`,
        ]
      : []),
  ];
  return steps.length === 0
    ? {
        id: "rooms",
        title: "Rooms",
        required: false,
        status: "ready",
        words: `Proposals are read from Rooms at ${origin}.`,
      }
    : {
        id: "rooms",
        title: "Rooms",
        required: false,
        status: "not_configured",
        words: `Not configured: proposals aren't read from Rooms. ${steps.join(" ")}`,
      };
};

const discordBotCheck = (envOf: Env): ReadinessCheck => {
  const key = envOf.DISCORD_PUBLIC_KEY?.trim() ?? "";
  const staff = staffIds(envOf).size;
  const missing = [
    ...(publicKeyPattern.test(key) ? [] : ["DISCORD_PUBLIC_KEY"]),
    ...(staff === 0 ? ["DISCORD_STAFF_IDS"] : []),
  ];
  return missing.length === 0
    ? {
        id: "discord_bot",
        title: "Discord bot",
        required: false,
        status: "ready",
        words: `The Discord bot answers ${staff} ${staff === 1 ? "staff member" : "staff members"}, and refuses anyone else.`,
      }
    : {
        id: "discord_bot",
        title: "Discord bot",
        required: false,
        status: "not_configured",
        words: `Not configured: the Discord bot refuses everything. ${varStep(missing.join(" and "))}`,
      };
};

/** The checklist, as this admin stands now. */
export const readinessOf = async (envOf: Env): Promise<Readiness> => {
  const db = adminDatabase(envOf.DB);
  const [choices, [imported], manifest, missing] = await Promise.all([
    destinationChoices(db, policyId),
    db.select({ n: count() }).from(releases),
    newestManifest(envOf),
    missingSecrets(envOf, requiredSecrets),
  ]);
  const newestId = manifest?.releaseId ?? null;
  // The one new organizations go in, or with several, each of them.
  const automatic = automaticChoice(choices).destinationId;
  const placeable =
    automatic === null
      ? choices
          .filter(({ shared, problems }) => shared && problems.length === 0)
          .map(({ id }) => id)
      : [automatic];
  const checks: ReadinessCheck[] = [
    stageCheck(envOf),
    domainCheck(envOf),
    destinationCheck(choices),
    releaseCheck(imported?.n ?? 0, newestId),
    secretsCheck(missing),
    await deployerCheck(
      envOf,
      placeable,
      missing.includes("DEPLOYER_API_TOKEN")
    ),
    modelSpendCheck(manifest),
    await alertsCheck(envOf),
    await roomsCheck(envOf),
    discordBotCheck(envOf),
  ];
  return {
    checks,
    blocking: checks.filter(
      ({ required, status }) => required && status !== "ready"
    ).length,
  };
};

/** Platform's Readiness, as this admin stands now. */
export const fetchReadiness = createServerFn({ method: "GET" }).handler(
  async () => await readinessOf(env)
);
