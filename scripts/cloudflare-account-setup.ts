/**
 * Sets up a fresh Cloudflare account for the platform: everything the
 * admin, the router and the clients' Workers for Platforms namespace need
 * before and around their first deploy, checked before it's created, so
 * running it again changes nothing that's there (GRA-283, GRA-430).
 *
 *   node scripts/cloudflare-account-setup.ts [--account <id>] [--dry-run]
 *
 * It drives Cloudflare's `cf` CLI, signed in with its own login (`cf
 * login`), never an API token: the account is `--account`, or
 * CLOUDFLARE_ACCOUNT_ID when that's not given. In order:
 * 1. each stage's clients' dispatch namespace (`grasp-clients`,
 *    `grasp-clients-staging`), which its router and admin bind;
 * 2. the admin's D1 database and R2 bucket, in the EU jurisdiction, and the
 *    router's hostname map (KV, which holds routing only), by the names the
 *    two wrangler.jsonc files and scripts/wrangler-deploy.ts look them up by;
 * 3. the account's one Secrets Store, and the names of the secrets the two
 *    Workers bind that it lacks: listed, never created, since a secret is
 *    created with its value, which an operator puts in themselves;
 * 4. on the clients' zone (`CLIENT_DOMAIN`, `ongrasp.app` unless set): a
 *    proxied wildcard record, and Email Routing on with its catch-all to the
 *    router.
 *
 * cf has no command yet for a Worker route, a Worker custom domain or a new
 * Secrets Store, so those three are reported `manual`, with what to set by
 * hand: the route `*.<domain>/*` to the router, the admin's custom domain
 * (`ADMIN_HOST`, `admin.<domain>` unless set) and, on an account without
 * one, the store. The catch-all names the router, which must be deployed
 * first: until then it's reported pending, and running the script again
 * after the first deploy (deploy-ops) finishes it. The zone itself isn't
 * added: adding one means delegating its nameservers, which is the domain
 * owner's to do. Workers, Durable Objects, workflows and client resources
 * are deploys' and provisioning's, never this script's.
 *
 * It never reads, prints or writes a secret's value: it only lists secrets'
 * names, and errors name the cf command and what cf said. With `--dry-run`
 * it only runs cf's list and get commands, and says what it would create.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");

/**
 * What a fresh account needs, for production and staging, by the names
 * deploys look each up by (Nick's scheme, @grasp-os/shared/names once the
 * platform naming PR lands: grasp-<what>, -staging appended for staging).
 */
export const accountPlan = {
  /** Each stage's clients' Workers for Platforms namespace. */
  dispatchNamespaces: ["grasp-clients", "grasp-clients-staging"],
  /** The admin's database (apps/admin/wrangler.jsonc, `DB`). */
  d1: [
    { name: "grasp-admin", jurisdiction: "eu" },
    { name: "grasp-admin-staging", jurisdiction: "eu" },
  ],
  /** The admin's releases (apps/admin/wrangler.jsonc, `RELEASES`). */
  r2: [
    { name: "grasp-releases", jurisdiction: "eu" },
    { name: "grasp-releases-staging", jurisdiction: "eu" },
  ],
  /** The router's hostname map, by the title scripts/wrangler-deploy.ts finds. */
  kv: ["grasp-router-hosts", "grasp-router-hosts-staging"],
  /** The store's name, when the account has none yet. */
  secretsStore: "grasp",
  /** Production's Workers, which the zone's route and custom domain name. */
  workers: { admin: "grasp-admin", router: "grasp-router" },
} as const;

/** The wrangler configs whose Secrets Store bindings name the secrets needed. */
const configs = ["apps/admin/wrangler.jsonc", "apps/router/wrangler.jsonc"];

/** The secrets `config`'s Secrets Store bindings name. */
export const boundSecrets = (config: string): string[] =>
  [...config.matchAll(/"secret_name"\s*:\s*"(?<name>[^"]+)"/gu)].flatMap(
    (match) => (match.groups?.name === undefined ? [] : [match.groups.name])
  );

/** Every secret the admin and the router bind, once each, sorted. */
export const neededSecrets = (
  read = (file: string) => readFileSync(path.join(root, file), "utf-8")
): string[] =>
  [...new Set(configs.flatMap((file) => boundSecrets(read(file))))].toSorted();

/** How a step ended. */
export type Outcome =
  | "exists"
  | "created"
  | "would_create"
  | "pending"
  | "missing"
  | "manual";

/** One step's report: what, how it ended, and why, never a secret. */
export interface Report {
  step: string;
  outcome: Outcome;
  detail?: string;
}

/**
 * Runs one cf command (its arguments, after `cf`) and answers what it
 * printed, parsed: cf prints a command's result as JSON, a list as an
 * array, and nothing for a change that returns no data (null).
 */
export type Cf = (args: readonly string[]) => Promise<unknown>;

/** A cf command that failed: the command, and what cf said. */
export class CfCommandError extends Error {
  constructor(args: readonly string[], said: string) {
    super(`cf ${args.join(" ")} failed: ${said}`);
    this.name = "CfCommandError";
  }
}

/** `value[key]` when value is an object, else undefined. */
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

const isList = (value: unknown): value is unknown[] => Array.isArray(value);

/** A list cf answered, or the list under `key` when it answered an object. */
const listOf = (answer: unknown, key?: string): unknown[] => {
  if (isList(answer)) {
    return answer;
  }
  const inner = key === undefined ? undefined : field(answer, key);
  return isList(inner) ? inner : [];
};

/** A page of a paged list, at most this long. */
const perPage = 100;
/** More pages than any list here has: past it, cf is taken to ignore `--page`. */
const pagesMax = 100;

/** Every item of a paged cf list, page by page. */
const allPages = async (
  cf: Cf,
  args: readonly string[]
): Promise<unknown[]> => {
  const items: unknown[] = [];
  for (let page = 1; page <= pagesMax; page += 1) {
    const paging = ["--page", `${page}`, "--per-page", `${perPage}`];
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const answer = listOf(await cf([...args, ...paging]));
    items.push(...answer);
    if (answer.length < perPage) {
      return items;
    }
  }
  throw new Error(
    `cf ${args.join(" ")} answered more than ${pagesMax} full pages: is it paging?`
  );
};

/** What one run works with. */
export interface SetupOptions {
  /** The clients' zone: their hostnames are `<id>.<domain>`. */
  domain: string;
  /** The admin's hostname. */
  adminHost: string;
  dryRun: boolean;
  /** cf, already pointed at the account (`cfRunner`). */
  cf: Cf;
  /** The account's id, to find the zone in it. */
  accountId: string;
  /** The secrets the Workers bind (`neededSecrets`). */
  secrets: readonly string[];
}

/** A step that finds or creates one thing. */
const ensure = async (
  reports: Report[],
  step: string,
  dryRun: boolean,
  find: () => Promise<boolean>,
  create: () => Promise<void>
): Promise<boolean> => {
  if (await find()) {
    reports.push({ step, outcome: "exists" });
    return true;
  }
  if (dryRun) {
    reports.push({ step, outcome: "would_create" });
    return false;
  }
  await create();
  reports.push({ step, outcome: "created" });
  return true;
};

/** The names of the items in `items`, read from `key`. */
const namesOf = (items: unknown[], key: string): string[] =>
  items.flatMap((item) => {
    const name = field(item, key);
    return typeof name === "string" ? [name] : [];
  });

/** Step 1 and 2: the namespace, the databases, buckets and map. */
const storageSteps = async (
  { cf, dryRun }: SetupOptions,
  reports: Report[]
): Promise<void> => {
  for (const dispatchNamespace of accountPlan.dispatchNamespaces) {
    // oxlint-disable-next-line no-await-in-loop -- one namespace at a time
    await ensure(
      reports,
      `dispatch namespace ${dispatchNamespace}`,
      dryRun,
      async () =>
        namesOf(
          listOf(
            await cf(["workers-for-platforms", "dispatch-namespaces", "list"])
          ),
          "namespace_name"
        ).includes(dispatchNamespace),
      async () => {
        await cf([
          "workers-for-platforms",
          "dispatch-namespaces",
          "create",
          "--name",
          dispatchNamespace,
        ]);
      }
    );
  }
  for (const { name, jurisdiction } of accountPlan.d1) {
    // oxlint-disable-next-line no-await-in-loop -- one database at a time
    await ensure(
      reports,
      `D1 database ${name} (${jurisdiction})`,
      dryRun,
      async () => {
        const databases = await allPages(cf, ["d1", "list", "--name", name]);
        const database = databases.find((each) => field(each, "name") === name);
        if (database === undefined) {
          return false;
        }
        const held = field(database, "jurisdiction");
        // Never taken as the EU on silence.
        if (held !== jurisdiction) {
          throw new Error(
            `D1 database ${name} exists in jurisdiction ${String(held)}, not ${jurisdiction}: move it by hand`
          );
        }
        return true;
      },
      async () => {
        await cf([
          "d1",
          "create",
          "--name",
          name,
          "--jurisdiction",
          jurisdiction,
        ]);
      }
    );
  }
  for (const { name, jurisdiction } of accountPlan.r2) {
    // oxlint-disable-next-line no-await-in-loop -- one bucket at a time
    await ensure(
      reports,
      `R2 bucket ${name} (${jurisdiction})`,
      dryRun,
      async () =>
        namesOf(
          listOf(
            await cf([
              "r2",
              "buckets",
              "list",
              "--name-contains",
              name,
              "--cf-r2-jurisdiction",
              jurisdiction,
            ]),
            "buckets"
          ),
          "name"
        ).includes(name),
      async () => {
        await cf([
          "r2",
          "buckets",
          "create",
          "--name",
          name,
          "--cf-r2-jurisdiction",
          jurisdiction,
        ]);
      }
    );
  }
  for (const title of accountPlan.kv) {
    // oxlint-disable-next-line no-await-in-loop -- one namespace at a time
    await ensure(
      reports,
      `KV namespace ${title}`,
      dryRun,
      async () => {
        const found = namesOf(
          await allPages(cf, ["kv", "namespaces", "list"]),
          "title"
        ).filter((each) => each === title);
        if (found.length > 1) {
          throw new Error(
            `The account has ${found.length} KV namespaces titled ${title}: deploys need one`
          );
        }
        return found.length === 1;
      },
      async () => {
        await cf(["kv", "namespaces", "create", "--title", title]);
      }
    );
  }
};

/** Step 3: the account's one store, and the secrets it lacks, by name. */
const secretSteps = async (
  { cf, secrets }: SetupOptions,
  reports: Report[]
): Promise<void> => {
  // The account's one store: scripts/wrangler-deploy.ts binds the only one.
  const stores = await allPages(cf, ["secrets-store", "stores", "list"]);
  if (stores.length > 1) {
    throw new Error(
      `The account has ${stores.length} Secrets Stores: deploys bind the only one`
    );
  }
  const storeId = field(stores[0], "id");
  if (typeof storeId !== "string") {
    reports.push(
      { step: "Secrets Store", outcome: "manual" },
      {
        step: "Secrets Store secrets",
        outcome: "missing",
        // cf can't create a store yet; names only, values are the operator's.
        detail: `create a Secrets Store named ${accountPlan.secretsStore} in the dashboard, put these in: ${secrets.join(", ")}, then run again`,
      }
    );
    return;
  }
  reports.push({ step: "Secrets Store", outcome: "exists" });
  const held = new Set(
    namesOf(
      await allPages(cf, [
        "secrets-store",
        "secrets",
        "list",
        "--store-id",
        storeId,
      ]),
      "name"
    )
  );
  const missing = secrets.filter((name) => !held.has(name));
  reports.push(
    missing.length === 0
      ? { step: "Secrets Store secrets", outcome: "exists" }
      : {
          step: "Secrets Store secrets",
          outcome: "missing",
          // Names only: values are the operator's to put in.
          detail: `put these in: ${missing.join(", ")}`,
        }
  );
};

/** The zone's Email Routing catch-all: to the router, once it's deployed. */
const catchAllStep = async (
  { cf, domain, dryRun }: SetupOptions,
  zone: string[],
  routerDeployed: boolean,
  reports: Report[]
): Promise<void> => {
  const step = "Email Routing catch-all";
  const { router } = accountPlan.workers;
  const catchAll = await cf([
    "email-routing",
    "rules",
    "catch-all",
    "get",
    ...zone,
  ]);
  const enabled = field(catchAll, "enabled") === true;
  const actions = listOf(field(catchAll, "actions"));
  const toRouter =
    enabled &&
    actions.some((action) => {
      const value = field(action, "value");
      return (
        field(action, "type") === "worker" &&
        isList(value) &&
        value.includes(router)
      );
    });
  // A catch-all that already sends mail somewhere else is someone's, even
  // switched off: never repointed here.
  if (!toRouter && actions.some((action) => field(action, "type") !== "drop")) {
    throw new Error(
      `${domain}'s Email Routing catch-all sends mail somewhere other than ${router}: change it by hand`
    );
  }
  if (toRouter) {
    reports.push({ step, outcome: "exists" });
  } else if (!routerDeployed) {
    reports.push({
      step,
      outcome: "pending",
      detail: `deploy ${router}, then run again`,
    });
  } else if (dryRun) {
    reports.push({ step, outcome: "would_create" });
  } else {
    await cf([
      "email-routing",
      "rules",
      "catch-all",
      "update",
      ...zone,
      "--body",
      JSON.stringify({
        actions: [{ type: "worker", value: [router] }],
        matchers: [{ type: "all" }],
        enabled: true,
        name: "Every client's mail, to the router",
      }),
    ]);
    reports.push({ step, outcome: "created" });
  }
};

/** The record types that can carry the wildcard to the router. */
const addressTypes = new Set(["A", "AAAA", "CNAME"]);

/** The wildcard's origin: none (the discard prefix), since the route answers. */
const wildcardOrigin = "100::";

/** The suffix of Email Routing's own MX hosts (route1.mx.cloudflare.net, …). */
const emailRoutingMx = ".mx.cloudflare.net";

/** Step 4: the zone's wildcard record, route, custom domain and Email Routing. */
const zoneSteps = async (
  options: SetupOptions,
  reports: Report[]
): Promise<void> => {
  const { cf, accountId, domain, adminHost, dryRun } = options;
  const zones = listOf(
    await cf(["zones", "list", "--name", domain, "--account-id", accountId])
  );
  const found = zones.find((each) => field(each, "name") === domain);
  const zoneId = field(found, "id");
  if (typeof zoneId !== "string") {
    reports.push({
      step: `zone ${domain}`,
      outcome: "pending",
      detail:
        "add the zone to this account and delegate its nameservers, then run again",
    });
    return;
  }
  const nameServers = listOf(field(found, "name_servers")).map(String);
  // Added but not yet delegated: DNS can be prepared, Email Routing can't.
  const active = field(found, "status") === "active";
  reports.push(
    active
      ? { step: `zone ${domain}`, outcome: "exists" }
      : {
          step: `zone ${domain}`,
          outcome: "pending",
          detail: `point its nameservers at ${nameServers.join(" and ")}, then run again`,
        }
  );
  const zone = ["--zone", zoneId];
  const { admin, router } = accountPlan.workers;
  const wildcard = `*.${domain}`;

  await ensure(
    reports,
    `DNS record ${wildcard}`,
    dryRun,
    async () => {
      const atWildcard = await allPages(cf, [
        "dns",
        "records",
        "list",
        ...zone,
        "--name",
        wildcard,
      ]);
      const records = atWildcard.filter((record) =>
        addressTypes.has(String(field(record, "type")))
      );
      if (records.length === 0) {
        return false;
      }
      // Anything but this script's own proxied record is someone's: it
      // would send clients' hostnames to its origin, changed by hand.
      const ours = records.every(
        (record) =>
          field(record, "type") === "AAAA" &&
          field(record, "content") === wildcardOrigin &&
          field(record, "proxied") === true
      );
      if (!ours) {
        throw new Error(
          `${wildcard} already has a record that isn't the router's proxied ${wildcardOrigin}: change it by hand`
        );
      }
      return true;
    },
    async () => {
      // Proxied, to no origin: only for the route to the router to apply.
      await cf([
        "dns",
        "records",
        "create",
        ...zone,
        "--body",
        JSON.stringify({
          type: "AAAA",
          name: wildcard,
          content: wildcardOrigin,
          proxied: true,
          ttl: 1,
        }),
      ]);
    }
  );

  // cf has no command for these two yet: set by hand, once each Worker is
  // deployed. The custom domain takes precedence over the wildcard route.
  reports.push(
    {
      step: `route ${wildcard}/*`,
      outcome: "manual",
      detail: `once ${router} is deployed, route ${wildcard}/* to it (Workers > ${router} > Domains & Routes), unless it already is`,
    },
    {
      step: `custom domain ${adminHost}`,
      outcome: "manual",
      detail: `once ${admin} is deployed, add ${adminHost} as its custom domain (Workers > ${admin} > Domains & Routes), unless it already is`,
    }
  );

  if (!active) {
    reports.push({
      step: `Email Routing on ${domain}`,
      outcome: "pending",
      detail: "Email Routing needs the zone active",
    });
    return;
  }
  const emailOn = await ensure(
    reports,
    `Email Routing on ${domain}`,
    dryRun,
    async () => {
      const settings = await cf(["email-routing", "settings", "get", ...zone]);
      if (field(settings, "enabled") === true) {
        return true;
      }
      // Turning it on replaces the zone's MX records: mail that goes
      // somewhere already is someone's, never taken over here.
      const mx = await allPages(cf, [
        "dns",
        "records",
        "list",
        ...zone,
        "--type",
        "MX",
        "--name",
        domain,
      ]);
      const foreign = mx.filter(
        (record) => !String(field(record, "content")).endsWith(emailRoutingMx)
      );
      if (foreign.length > 0) {
        throw new Error(
          `${domain} already has MX records for other mail: turn Email Routing on by hand if that's right`
        );
      }
      return false;
    },
    async () => {
      // Turns it on with the MX and SPF records it needs.
      await cf(["email-routing", "enable", ...zone, "--name", domain]);
    }
  );
  if (!emailOn) {
    reports.push({
      step: "Email Routing catch-all",
      outcome: "pending",
      detail: "turn Email Routing on first",
    });
    return;
  }
  const deployed = new Set(
    namesOf(await allPages(cf, ["workers", "list"]), "name")
  );
  await catchAllStep(options, zone, deployed.has(router), reports);
};

/** Sets the account up as `options` says (see the header): each step's report, in order. */
export const setUpAccount = async (
  options: SetupOptions
): Promise<Report[]> => {
  const reports: Report[] = [];
  await storageSteps(options, reports);
  await secretSteps(options, reports);
  await zoneSteps(options, reports);
  return reports;
};

/** Environment variables that would make cf use something other than its own login. */
const otherCredentials = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_EMAIL",
];

/** The real `cf`, on `accountId`, signed in with its own login. */
export const cfRunner = (accountId: string): Cf => {
  const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId };
  for (const name of otherCredentials) {
    Reflect.deleteProperty(env, name);
  }
  const cf: Cf = async (args) => {
    await Promise.resolve();
    let stdout = "";
    try {
      // One command at a time, as the steps run: synchronously, like
      // scripts/github-setup.ts runs gh.
      stdout = execFileSync("cf", [...args], {
        env,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (error) {
      const said = field(error, "stderr");
      throw new CfCommandError(
        args,
        typeof said === "string" && said.trim() !== ""
          ? said.trim()
          : String(error)
      );
    }
    if (stdout.trim() === "") {
      return null;
    }
    const answer: unknown = JSON.parse(stdout);
    return answer;
  };
  return cf;
};

/** `name` from the environment, when it's set to something. */
const setting = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
};

/** The value after `flag` on the command line, when it's there. */
const argument = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
};

if (import.meta.main) {
  const accountId = argument("--account") ?? setting("CLOUDFLARE_ACCOUNT_ID");
  if (accountId === undefined) {
    throw new Error(
      "Give the account: --account <id> or CLOUDFLARE_ACCOUNT_ID"
    );
  }
  const domain = setting("CLIENT_DOMAIN") ?? "ongrasp.app";
  const reports = await setUpAccount({
    accountId,
    domain,
    adminHost: setting("ADMIN_HOST") ?? `admin.${domain}`,
    dryRun: process.argv.includes("--dry-run"),
    cf: cfRunner(accountId),
    secrets: neededSecrets(),
  });
  for (const { step, outcome, detail } of reports) {
    console.log(
      `${outcome.padEnd(12)} ${step}${detail === undefined ? "" : `: ${detail}`}`
    );
  }
  if (
    reports.some(({ outcome }) => outcome !== "exists" && outcome !== "created")
  ) {
    console.log(
      "Some steps wait on something or need a hand: do what they say, then run this again."
    );
  }
}
