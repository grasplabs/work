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
 * | Clients' domain              | `ongrasp.app`           | `staging.ongrasp.app`            |
 * | Admin's host                 | `admin.ongrasp.app`     | `admin.staging.ongrasp.app`      |
 * | Auth relay's host            | `auth.ongrasp.app`      | `auth.staging.ongrasp.app`       |
 *
 * A staging client is never placed beside a production one: each stage
 * has its own namespace. Each placed client's resources are named after
 * its deployment id ({id}: 10 base32 characters the admin generates, never
 * the client's name), by the release's names for them (`clientRoleNames`):
 *
 * | A client's                   | Name                                    |
 * | ---------------------------- | --------------------------------------- |
 * | core and connect Workers     | `grasp-{id}-core`, `grasp-{id}-connect` |
 * | core's databases (D1)        | `grasp-{id}-core-db`, `-core-knowledge` |
 * | core's buckets (R2)          | `grasp-{id}-core-files`, `-core-audit`, `-core-brain` |
 * | connect's database (D1)      | `grasp-{id}-connect-db`                 |
 * | Durable Object classes       | `<its script>:<class>`                  |
 * Package scopes (`@grasp-os/*`) and code
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

/**
 * Grasp's Cloudflare account, "Grasp Work", where both stages run: an id,
 * not a credential.
 */
export const platformAccountId = "e8ff423bc46eb025fca37494777c1cc0";

/** The account's one Secrets Store, which both stages share. */
export const platformSecretsStoreId = "f134987a836f433abe211c817a51662e";

/** The account's R2 S3 endpoint, in the EU, where the releases buckets are. */
export const platformR2Endpoint = `https://${platformAccountId}.eu.r2.cloudflarestorage.com`;

/** The router's hostname map (KV) in `stage`, by its title. */
export const routerHostsName = (stage: Stage): string =>
  staged(`${namePrefix}router-hosts`, stage);

/** Production's domain; staging's is a subdomain of it. */
const productionDomain = "ongrasp.app";

/**
 * The domain `stage`'s clients are served under, a client being
 * `<id>.<domain>`: staging's is `staging.` below production's.
 */
export const clientDomain = (stage: Stage): string =>
  stage === "staging" ? `staging.${productionDomain}` : productionDomain;

/** The admin's own hostname in `stage`. */
export const adminHost = (stage: Stage): string =>
  `admin.${clientDomain(stage)}`;

/** The auth relay's hostname in `stage`. */
export const authRelayHost = (stage: Stage): string =>
  `auth.${clientDomain(stage)}`;

/** The Cloudflare zone every stage's hostnames are in: production's domain. */
export const platformZone = productionDomain;

/**
 * Where a platform Worker answers in `stage`, as its wrangler.jsonc
 * declares it (`routes`), so every deploy applies it:
 *
 * - the admin, on a custom domain of its own: `adminHost`;
 * - the router, on a route for every host below `clientDomain` (each
 *   client's, and the auth relay's), in `platformZone`;
 * - the connect gateway, nowhere: it is reached by service binding alone.
 *
 * Production's route, `*.ongrasp.app/*`, matches staging's hosts too, as
 * Cloudflare's `*` takes any number of labels. Cloudflare sends a request
 * to the most specific route that matches it, so staging's own
 * `*.staging.ongrasp.app/*` takes staging's hosts, and a Custom Domain
 * takes precedence over any route, so the admin's hosts never reach a
 * router. Each router still refuses another stage's host itself
 * (`stageOfHost`), should a route ever send it one.
 */
export const platformRoutes = (
  worker: PlatformWorker,
  stage: Stage
): { pattern: string; custom_domain?: true; zone_name?: string }[] => {
  if (worker === "admin") {
    return [{ pattern: adminHost(stage), custom_domain: true }];
  }
  if (worker === "router") {
    return [{ pattern: `*.${clientDomain(stage)}/*`, zone_name: platformZone }];
  }
  return [];
};

/**
 * The stage hostname `host` belongs to: staging for staging's domain and
 * everything below it, production for anything else. Staging's domain
 * sits below production's, so production's `*.ongrasp.app` would take a
 * staging host unless it asks this first; staging takes nothing of
 * production's, which is never below staging's domain.
 */
export const stageOfHost = (host: string): Stage => {
  const name = host.toLowerCase().replace(/\.$/u, "");
  const staging = clientDomain("staging");
  return name === staging || name.endsWith(`.${staging}`)
    ? "staging"
    : "production";
};

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

/**
 * `value` as a stage when it is exactly one, else undefined: never
 * production by default, so an admin whose STAGE is missing or misspelt
 * places no client anywhere (apps/admin/src/deploy/context.ts).
 */
export const stageNamed = (value: unknown): Stage | undefined =>
  stages.find((stage) => stage === value);

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

/** How long a placement's deployment id is (the admin generates it). */
export const deploymentIdLength = 10;

/** What a deployment id is made of: lowercase base32. */
export const deploymentIdAlphabet = "abcdefghijklmnopqrstuvwxyz234567";

/** The start of every name placement `deploymentId`'s resources have. */
export const deploymentPrefix = (deploymentId: string): string =>
  `${namePrefix}${deploymentId}-`;

/**
 * What each resource a release names becomes in a client's names, by its
 * inventory role (apps/admin/src/hosting/inventory.ts): its component,
 * then its purpose for storage. The release keeps its own names; a
 * resource not here isn't named, and the admin refuses to allocate it.
 */
export const clientRoleNames: Readonly<Record<string, string>> = {
  "worker:grasp-os-core": "core",
  "worker:grasp-os-connect": "connect",
  "d1:grasp-os-core": "core-db",
  "d1:grasp-os-knowledge": "core-knowledge",
  "r2:grasp-os-files": "core-files",
  "r2:grasp-os-audit-archive": "core-audit",
  "r2:grasp-os-brain-objects": "core-brain",
  "d1:grasp-os-connect": "connect-db",
};

/**
 * Placement `deploymentId`'s name for the resource with inventory role
 * `role`, or undefined for a role `clientRoleNames` doesn't name.
 */
export const clientResourceName = (
  deploymentId: string,
  role: string
): string | undefined => {
  const name = clientRoleNames[role];
  return name === undefined
    ? undefined
    : `${deploymentPrefix(deploymentId)}${name}`;
};

const deploymentIdSource = `[${deploymentIdAlphabet}]{${deploymentIdLength}}`;

/** A placed client's connect script: what the connect gateway may reach. */
export const clientConnectScriptPattern = new RegExp(
  `^${namePrefix}${deploymentIdSource}-connect$`,
  "u"
);
