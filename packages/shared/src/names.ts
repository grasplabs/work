/**
 * Every name the platform gives a Cloudflare resource on Grasp's account
 * (Nick, 28 Oct): one scheme, from this module alone.
 *
 * | What                         | Production              | Staging                          |
 * | ---------------------------- | ----------------------- | -------------------------------- |
 * | Admin Worker and its D1      | `grasp-admin`           | `grasp-admin-staging`            |
 * | Router Worker                | `grasp-router`          | `grasp-router-staging`           |
 * | Connect gateway Worker       | `grasp-connect-gateway` | `grasp-connect-gateway-staging`  |
 * | Releases bucket (R2)         | `grasp-releases`        | `grasp-releases-staging`         |
 * | Router's hostname map (KV)   | `grasp-router-hosts`    | `grasp-router-hosts-staging`     |
 * | Clients' dispatch namespace  | `grasp-clients`         | `grasp-clients-staging`          |
 * | A Secrets Store secret       | `NAME`                  | `NAME_STAGING`                   |
 *
 * A staging client is never placed beside a production one: each stage
 * has its own namespace. Package scopes (`@grasp-os/*`) and code
 * identifiers aren't Cloudflare names and keep their own.
 */

/** Where a platform Worker runs: Grasp's clients, or staging. */
export const stages = ["production", "staging"] as const;
export type Stage = (typeof stages)[number];

/** The start of every name in the scheme. */
export const namePrefix = "grasp-";

/** What a staging name ends with. */
const stagingSuffix = "-staging";

/** `base` in `stage`: as is in production, `-staging` appended in staging. */
const staged = (base: string, stage: Stage): string =>
  stage === "staging" ? `${base}${stagingSuffix}` : base;

/** The platform's own Workers. */
export const platformWorkers = ["admin", "router", "connect-gateway"] as const;
export type PlatformWorker = (typeof platformWorkers)[number];

/** Platform Worker `worker`'s name in `stage`. */
export const platformWorkerName = (
  worker: PlatformWorker,
  stage: Stage
): string => staged(`${namePrefix}${worker}`, stage);

/** The admin's D1 database in `stage`: named as its Worker. */
export const adminDatabaseName = (stage: Stage): string =>
  platformWorkerName("admin", stage);

/** The R2 bucket the admin imports releases from, in `stage`. */
export const releasesBucketName = (stage: Stage): string =>
  staged(`${namePrefix}releases`, stage);

/** The router's hostname map (KV) in `stage`, by its title. */
export const routerHostsName = (stage: Stage): string =>
  staged(`${namePrefix}router-hosts`, stage);

/** What a staging secret's name ends with in the account's Secrets Store. */
const stagingSecretSuffix = "_STAGING";

/**
 * The name secret `name` (a Worker's binding name, as 1Password holds it)
 * has in the account's one Secrets Store, in `stage`: as is in production,
 * `_STAGING` appended in staging. No secret is shared between stages, so a
 * staging deploy, which needs no reviewer, never writes what production
 * reads.
 */
export const storeSecretName = (name: string, stage: Stage): string =>
  stage === "staging" ? `${name}${stagingSecretSuffix}` : name;

/**
 * The Workers for Platforms dispatch namespace of `stage`'s clients: the
 * one its router and admin bind (`DISPATCHER`) and place clients in.
 */
export const clientsNamespace = (stage: Stage): string =>
  staged(`${namePrefix}clients`, stage);

/** The stage whose clients' namespace `namespace` is, if it's either's. */
export const stageOfNamespace = (namespace: unknown): Stage | undefined =>
  stages.find((stage) => clientsNamespace(stage) === namespace);

/** `value` as a stage, or production when it names none. */
export const stageOf = (value: unknown): Stage =>
  value === "staging" ? "staging" : "production";

/**
 * The longest name Cloudflare takes for a Worker, a D1 database, an R2
 * bucket, a KV namespace's title it shows in full, a Workflow and a
 * dispatch namespace alike.
 */
export const maxResourceName = 63;

/**
 * A name every one of those takes: lowercase letters, digits and `-`,
 * starting and ending with a letter or digit (R2's rule, the strictest),
 * at least 3 characters.
 */
export const resourceNamePattern = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u;

/** Whether `name` is one Cloudflare takes for every kind of resource above. */
export const isResourceName = (name: string): boolean =>
  name.length <= maxResourceName && resourceNamePattern.test(name);
