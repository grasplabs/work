/**
 * Each company's own Grasp as the admin runs it, and how a release reaches every company: the
 * records the admin (`apps/admin`) keeps, in the words its pages say them in. A company is a
 * client of the admin: its own Workers in Grasp's EU Workers for Platforms namespace, made and set
 * up by a provisioning run, then kept on its channel's release by deploys. Pure: the pages only say what this works
 * out, from the records the admin reads.
 */

/** A provisioning run, in order: the account made or adopted, the client recorded, Workers Paid confirmed by staff, the first deploy, and the client active. */
export const PROVISION_STEPS = [
  "account",
  "record",
  "paid",
  "deploy",
  "active",
] as const;
export type ProvisionStep = (typeof PROVISION_STEPS)[number];

/** A deploy, in order: the EU resources, the database migrations, the Workers with their secrets, a smoke check through the router, and the hostname in the router's map. */
export const DEPLOY_STEPS = [
  "resources",
  "migrations",
  "workers",
  "smoke",
  "router",
] as const;
export type DeployStep = (typeof DEPLOY_STEPS)[number];

/** The release channels a company follows, as the admin has them: Edge gets every release as it lands, Beta and Stable what Grasp promotes. */
export const CHANNELS = ["edge", "beta", "stable"] as const;
export type Channel = (typeof CHANNELS)[number];

/** The channels by name, as Grasp's staff say them. */
export const CHANNEL_NAMES: Readonly<Record<Channel, string>> = {
  edge: "Edge",
  beta: "Beta",
  stable: "Stable",
};

/** The Workers the admin deploys into a company's account. */
export type WorkerName = "core" | "connect";

export interface Release {
  /** As CI's publish names it: `YY.MM.N`. */
  id: string;
  commit: string;
  /** The day it was imported into the admin. */
  on: string;
  /** What changed, a line each, as the release says it. */
  changes: string[];
  /** Its database migrations, by number; a release with none can be rolled back without a care. */
  migrations: number;
}

export interface Deploy {
  id: string;
  release: string;
  /** A release, or on the release the company runs already only new secrets, only its settings, or both. */
  kind: "release" | "secrets" | "settings" | "settings_and_secrets";
  status: "running" | "done" | "failed" | "superseded";
  /** The last step that finished; none before the first. */
  step: DeployStep | null;
  /** Why it failed, as a code: never a token or a response. */
  error?: string;
  /** Who started it: someone at Grasp, or the admin's reconciler. */
  by: string;
  /** When it started, and how long it took. */
  at: string;
  minutes: number;
}

export interface PlatformWorker {
  name: WorkerName;
  /** The script's name in the company's account. */
  script: string;
  release: string;
  /** The version the admin last made live. */
  version: string;
  deployed: string;
  /** What the account runs now, as Cloudflare says: one version, or a split between two. None when unknown. */
  live: { version: string; share: number }[] | null;
}

export interface PlatformResource {
  kind: "d1" | "r2" | "gateway" | "secrets";
  name: string;
  /** What it holds, in a few words. */
  holds: string;
  /** Its size, where there is one, in megabytes. */
  size?: number;
}

/** One day of the company's own platform, as Cloudflare counts it. */
export interface UsageDay {
  on: string;
  requests: number;
  errors: number;
}

export interface Platform {
  /** The client's slug in the admin, which is also its address. */
  client: string;
  status: "none" | "provisioning" | "active" | "offboarded";
  address: string;
  /** The Cloudflare account, by id, and as it is named. */
  account: { id: string; name: string } | null;
  /** Where core answers before the address does: `<core>.<subdomain>.workers.dev`. */
  workersDev: string | null;
  channel: Channel;
  /** The release it stays on: promotions skip it. */
  pinned: string | null;
  /** The provisioning run, while there is one; none once the company is active, or before it starts. */
  provisioning: {
    step: ProvisionStep;
    state: "running" | "waiting" | "failed";
    since: string;
    error?: string;
  } | null;
  /** How its people sign in: its own Entra tenant and/or Google Workspace, its email domains and its first admins. */
  signIn: {
    providers: ("entra" | "google")[];
    domains: string[];
    admins: string[];
  } | null;
  /** Its derived secrets: their generation, when they last rotated, and whether that rotation is live. */
  secrets: { generation: number; rotated: string | null; live: boolean };
  /** When staff last changed what a deploy sets on its core: its next deploy carries it. */
  configChanged: string | null;
  resources: PlatformResource[];
  workers: PlatformWorker[];
  /** The newest first. */
  deploys: Deploy[];
  usage: {
    requestsMonth: number;
    cpuMsMonth: number;
    aiUsdMonth: number;
    days: UsageDay[];
  };
  /** The client in the admin, and the account in Cloudflare. */
  url: string | null;
}

/** Whether what runs is what the admin made live: one version, another, two at once, or the release it is pinned off. */
export type Drift = "in_sync" | "drifted" | "split" | "unknown" | "off_pin";

/** Whether staff pinned it to a release. */
const isPinned = (platform: Platform): boolean =>
  platform.pinned !== null && platform.pinned !== "";

export const driftOf = (platform: Platform): Drift => {
  if (platform.workers.length === 0) {
    return "unknown";
  }
  if (
    isPinned(platform) &&
    platform.workers.some((worker) => worker.release !== platform.pinned)
  ) {
    return "off_pin";
  }
  let unknown = false;
  for (const worker of platform.workers) {
    if (!worker.live) {
      unknown = true;
      continue;
    }
    if (worker.live.length > 1) {
      return "split";
    }
    if (worker.live[0]?.version !== worker.version) {
      return "drifted";
    }
  }
  return unknown ? "unknown" : "in_sync";
};

/** The release the company runs: core's, which is the one its people meet. */
export const releaseOf = (platform: Platform): string | null =>
  platform.workers.find((worker) => worker.name === "core")?.release ?? null;

/** Of the last day's requests, the share that ended in an error. None without requests. */
export const errorRateOf = (platform: Platform): number | null => {
  const last = platform.usage.days.at(-1);
  if (!last || last.requests === 0) {
    return null;
  }
  return last.errors / last.requests;
};

/** An error rate at or above this needs a look. */
export const ERROR_RATE = 0.01;

/** What about a company's platform needs someone at Grasp, the most pressing first. */
export type PlatformNeed =
  | { kind: "failed"; deploy: Deploy }
  | {
      kind: "provisioning";
      step: ProvisionStep;
      state: "waiting" | "failed";
      error?: string;
    }
  | { kind: "drift"; drift: Exclude<Drift, "in_sync" | "unknown"> }
  | { kind: "errors"; rate: number }
  | { kind: "secrets" };

/** A provisioning run that stopped, waiting on staff or failed; none while it runs. */
const stoppedProvisioning = (platform: Platform): PlatformNeed[] => {
  const run = platform.provisioning;
  if (!run || run.state === "running") {
    return [];
  }
  return [
    {
      kind: "provisioning",
      step: run.step,
      state: run.state,
      ...(run.error === undefined || run.error === ""
        ? {}
        : { error: run.error }),
    },
  ];
};

export const needsOf = (platform: Platform): PlatformNeed[] => {
  const needs: PlatformNeed[] = [];
  const [last] = platform.deploys;
  if (last?.status === "failed") {
    needs.push({ kind: "failed", deploy: last });
  }
  needs.push(...stoppedProvisioning(platform));
  const drift = driftOf(platform);
  if (drift === "drifted" || drift === "split" || drift === "off_pin") {
    needs.push({ kind: "drift", drift });
  }
  const rate = errorRateOf(platform);
  if (rate !== null && rate >= ERROR_RATE) {
    needs.push({ kind: "errors", rate });
  }
  if (platform.status === "active" && !platform.secrets.live) {
    needs.push({ kind: "secrets" });
  }
  return needs;
};

/** How a company's platform stands, as one word: not there yet, being set up, fine, or with something to look at. */
export const standingOf = (
  platform: Platform
): "none" | "setup" | "healthy" | "attention" => {
  if (platform.status === "none") {
    return "none";
  }
  if (needsOf(platform).length > 0) {
    return "attention";
  }
  if (platform.status === "provisioning") {
    return "setup";
  }
  return "healthy";
};
