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
import { aiProviders } from "@grasp-os/shared/ai-providers";
import {
  clientDomain as stageDomain,
  stageNamed,
} from "@grasp-os/shared/names";
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { count, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { adminDatabase } from "../db/act.ts";
import { hostingDestinations, releases } from "../db/schema.ts";
import {
  clientDomain,
  deployerApi,
  ifStored,
  platformKeyProviders,
  storeSecret,
} from "../deploy/context.ts";
import { errorCode } from "../deploy/errors.ts";
import { automaticChoice, destinationChoices } from "../hosting/placement.ts";
import type { DestinationChoice } from "../hosting/placement.ts";
import { platformAiOf, platformAiProviders } from "../platform-ai.ts";
import { platformSettingsView } from "../platform-settings.ts";
import type { PlatformSettingsView } from "../platform-settings.ts";
import { discordPublicKey, staffIds } from "./discord-settings.ts";

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
export type CheckLink =
  | "releases"
  | "platform"
  | "platform_ai"
  | "organizations";

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

/**
 * Where new organizations go: the shared destination the admin places
 * them in by itself (`automaticChoice`, which always picks one when there
 * is one), or that there's none yet.
 */
const destinationCheck = (choices: DestinationChoice[]): ReadinessCheck => {
  const automatic = automaticChoice(choices);
  if (automatic.destinationId !== null) {
    return {
      id: "destination",
      title: "Hosting destination",
      required: true,
      status: "ready",
      words: `New organizations are placed in ${automatic.destinationId}, Grasp's shared destination.`,
    };
  }
  return {
    id: "destination",
    title: "Hosting destination",
    required: true,
    status: "blocked",
    words:
      "There's no shared destination to place organizations in yet. The admin records its stage's own Workers for Platforms namespace as one once STAGE names a stage and the deployer's account is set.",
    link: "organizations",
  };
};

/** The newest imported release's id; null before any. */
const newestRelease = async (envOf: Env): Promise<string | null> => {
  const [row] = await adminDatabase(envOf.DB)
    .select({ id: releases.id })
    .from(releases)
    .orderBy(desc(releases.builtAt))
    .limit(1);
  return row?.id ?? null;
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

/** `items` in a sentence: "a", "a and b", "a, b and c". */
const listed = (items: readonly string[]): string =>
  items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** Each platform AI feature, as a sentence names it. */
const platformFeatureWords = {
  conversion: "document conversion",
  transcription: "transcription",
  speech: "speech",
} as const;

/**
 * Grasp's own AI features (conversion, transcription, speech): whether
 * Secrets Store has Grasp's key for each provider Platform → AI chose.
 * Optional: provisioning and deploys go on without a key, and connect
 * then has no route for that provider, so only the features on it say
 * they aren't configured yet until the key is there.
 */
const platformAiCheck = async (envOf: Env): Promise<ReadinessCheck> => {
  const [settings, keyed] = await Promise.all([
    platformAiOf(adminDatabase(envOf.DB)),
    platformKeyProviders(envOf),
  ]);
  const unkeyed = platformAiProviders(settings).filter(
    ({ provider }) => !keyed.has(provider)
  );
  const missing = [
    ...new Set(
      unkeyed
        .map(({ provider }) => aiProviders[provider].platformSecret)
        .filter((name) => name !== undefined)
    ),
  ];
  const check = {
    id: "platform_ai",
    title: "Grasp's AI",
    required: false,
    link: "platform_ai",
  } as const;
  if (missing.length === 0) {
    return {
      ...check,
      status: "ready",
      words:
        "Secrets Store has Grasp's key for every provider Platform → AI chose.",
    };
  }
  const features = [
    ...new Set(unkeyed.map(({ feature }) => platformFeatureWords[feature])),
  ];
  return {
    ...check,
    status: "not_configured",
    words: `Secrets Store has no ${listed(missing)}, so ${listed(features)} ${features.length === 1 ? "isn't" : "aren't"} configured yet in any organization; everything else works. ${secretStep([listed(missing)])} Or choose another provider on Platform → AI.`,
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
  const key = discordPublicKey(envOf);
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

/**
 * Grasp's own organization (src/platform-settings.ts): optional, as only
 * Ask Grasp needs it, and ready once the one chosen is live.
 */
const graspOrganizationCheck = ({
  graspClientId,
  graspClientName,
  candidates,
}: PlatformSettingsView): ReadinessCheck => {
  const check = {
    id: "grasp_organization",
    title: "Grasp's own organization",
    required: false,
    link: "platform",
  } as const;
  if (graspClientId === null) {
    return {
      ...check,
      status: "not_configured",
      words:
        "None is chosen, so Ask Grasp isn't set up. Choose it under Grasp's own organization on this page.",
    };
  }
  if (graspClientName === null) {
    return {
      ...check,
      status: "not_configured",
      words: `The one chosen (${graspClientId}) is gone or offboarded, so Ask Grasp isn't set up. Choose it again under Grasp's own organization on this page.`,
    };
  }
  const live = candidates.some(
    ({ id, status }) => id === graspClientId && status === "active"
  );
  return live
    ? {
        ...check,
        status: "ready",
        words: `${graspClientName} answers Ask Grasp.`,
      }
    : {
        ...check,
        status: "waiting",
        words: `${graspClientName} is chosen, and answers Ask Grasp once it's live.`,
      };
};

/** The checklist, as this admin stands now. */
export const readinessOf = async (envOf: Env): Promise<Readiness> => {
  const db = adminDatabase(envOf.DB);
  const [choices, [imported], newestId, missing, settings] = await Promise.all([
    destinationChoices(db),
    db.select({ n: count() }).from(releases),
    newestRelease(envOf),
    missingSecrets(envOf, requiredSecrets),
    platformSettingsView(db),
  ]);
  // The one new organizations go in: what the deployer must reach.
  const automatic = automaticChoice(choices).destinationId;
  const placeable = automatic === null ? [] : [automatic];
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
    await platformAiCheck(envOf),
    await roomsCheck(envOf),
    discordBotCheck(envOf),
    graspOrganizationCheck(settings),
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
