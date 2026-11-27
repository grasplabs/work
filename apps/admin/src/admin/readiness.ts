/**
 * Platform's Readiness: whether this admin can onboard an organization
 * now, one check a line, each with a plain status and what to do next.
 * Every check reads what the admin reads when it acts (its vars, Secrets
 * Store, its releases, the Cloudflare API as the
 * deployer), so a red line is the reason the action would fail, before
 * anyone tries it. Required lines that aren't ready put a banner on Home.
 *
 * Nothing secret leaves here: a secret is named, never its value, and an
 * API failure is its code.
 */
import {
  clientDomain as stageDomain,
  clientsNamespace,
  platformAccountId,
  stageNamed,
} from "@grasp-os/shared/names";
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { count, desc } from "drizzle-orm";
import { z } from "zod";

import { adminDatabase } from "../db/act.ts";
import { releases } from "../db/schema.ts";
import {
  clientDomain,
  deployerApi,
  ifStored,
  storeSecret,
} from "../deploy/context.ts";
import { errorCode } from "../deploy/errors.ts";

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
export type CheckLink = "releases" | "organizations";

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

/** The deployer check, waiting for a line above it, saying for which. */
const deployerWaiting = (words: string): ReadinessCheck => ({
  id: "deployer",
  title: "Deployer token",
  required: true,
  status: "waiting",
  words,
});

/**
 * Whether the deployer's token reaches the stage's destination: Grasp's
 * account and the stage's clients' Workers for Platforms namespace
 * (@grasp-os/shared/names), read as the deployer.
 */
const deployerCheck = async (
  envOf: Env,
  tokenMissing: boolean
): Promise<ReadinessCheck> => {
  if (tokenMissing) {
    return deployerWaiting(
      "Checked once DEPLOYER_API_TOKEN is in Secrets Store."
    );
  }
  const stage = stageNamed(envOf.STAGE);
  if (stage === undefined) {
    return deployerWaiting("Checked once STAGE names a stage.");
  }
  const namespace = clientsNamespace(stage);
  const check = {
    id: "deployer",
    title: "Deployer token",
    required: true,
  } as const;
  try {
    const api = await deployerApi(envOf, {
      waitBudgetMs: 0,
      signal: AbortSignal.timeout(reachTimeoutMs),
    });
    await api.call(
      {
        method: "GET",
        path: `/accounts/${platformAccountId}/workers/dispatch/namespaces/${encodeURIComponent(namespace)}`,
      },
      z.unknown()
    );
    return {
      ...check,
      status: "ready",
      words: `The deployer's token reaches ${namespace} in Grasp's account.`,
    };
  } catch (error) {
    return {
      ...check,
      status: "blocked",
      words: `The deployer's token can't reach ${namespace} in Grasp's account (${errorCode(error)}). Give the token Workers for Platforms edit on that account, or put the right one in the stage's 1Password Environment as DEPLOYER_API_TOKEN, then run Deploy platform.`,
    };
  }
};

/** Composio's API, as connect calls it (connect's src/composio.ts). */
const composioApi = "https://backend.composio.dev/api/v3.1";

/**
 * Each permission area of Composio's scoped project keys a Composio
 * connection needs to read, by a read of one item it allows (Composio's
 * "Scoped Project API Key" routes): auth configs and connected accounts,
 * which connecting makes and disconnecting deletes, and sessions, one of
 * which serves each connection.
 */
const composioAreas = [
  ["Auth configs", "/auth_configs?limit=1"],
  ["Connected accounts", "/connected_accounts?limit=1"],
  ["Session management", "/session_configs?limit=1"],
] as const;

/**
 * What the key needs, in the words of Composio's dashboard: writing what
 * a connection makes, running its tools through the session (which only a
 * call can show), and reading toolkits and their tools for the catalog.
 */
const composioNeeds =
  "Auth configs, Connected accounts and Session management each Read and write, Session tool execution Write only, and Toolkits and Tools Read only; MCP (Legacy) isn't needed";

/** The Composio check, but for its status and words. */
const composioLine = { id: "composio", title: "Composio key", required: false };

/** Composio's status for a read at `path` with `key`; undefined for none. */
const composioStatus = async (
  key: string,
  path: string
): Promise<number | undefined> => {
  try {
    const response = await fetch(`${composioApi}${path}`, {
      headers: { "x-api-key": key, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(reachTimeoutMs),
    });
    await response.body?.cancel();
    return response.status;
  } catch {
    return undefined;
  }
};

/**
 * Whether the Composio key every organization gets may read what a
 * Composio connection needs (`composioAreas`), each with a list of one, so
 * nothing is made: a scoped project key without one of those permissions
 * is refused there (401 or 403), as every Composio connection then is. A
 * key that may only read passes here, and shows at the connection.
 */
const composioCheck = async (
  envOf: Env,
  keyMissing: boolean
): Promise<ReadinessCheck> => {
  if (keyMissing) {
    return {
      ...composioLine,
      status: "waiting",
      words: "Checked once COMPOSIO_API_KEY is in Secrets Store.",
    };
  }
  const key = await storeSecret(envOf, "COMPOSIO_API_KEY");
  const read = await Promise.all(
    composioAreas.map(async ([area, path]) => ({
      area,
      status: await composioStatus(key, path),
    }))
  );
  const refused = read.filter(({ status }) => status === 401 || status === 403);
  if (refused.length > 0) {
    return {
      ...composioLine,
      status: "blocked",
      words: `Composio refuses this key ${refused.map(({ area, status }) => `${area} (${status})`).join(", ")}, so every Composio connection fails. In Composio's dashboard, give the project a default API key, or a scoped one with ${composioNeeds}, put it in the stage's 1Password Environment as COMPOSIO_API_KEY, then run Deploy platform and redeploy the organizations, so their connect gets it.`,
    };
  }
  const unread = read.find(
    ({ status }) => status === undefined || status < 200 || status >= 300
  );
  if (unread !== undefined) {
    return {
      ...composioLine,
      status: "blocked",
      words: `Composio couldn't be asked whether this key reads ${unread.area} (${unread.status ?? "no answer"}). Check again shortly.`,
    };
  }
  return {
    ...composioLine,
    status: "ready",
    words: `Composio's key reads what a Composio connection needs. It needs ${composioNeeds}.`,
  };
};

/** The checklist, as this admin stands now. */
const readinessOf = async (envOf: Env): Promise<Readiness> => {
  const db = adminDatabase(envOf.DB);
  const [[imported], newestId, missing] = await Promise.all([
    db.select({ n: count() }).from(releases),
    newestRelease(envOf),
    missingSecrets(envOf, requiredSecrets),
  ]);
  // Each asks a service of its own, so they ask at once.
  const [deployer, composio] = await Promise.all([
    deployerCheck(envOf, missing.includes("DEPLOYER_API_TOKEN")),
    composioCheck(envOf, missing.includes("COMPOSIO_API_KEY")),
  ]);
  const checks: ReadinessCheck[] = [
    stageCheck(envOf),
    domainCheck(envOf),
    releaseCheck(imported?.n ?? 0, newestId),
    secretsCheck(missing),
    deployer,
    composio,
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
