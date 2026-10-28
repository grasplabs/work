/**
 * Sets up a fresh Cloudflare account for the platform: everything the
 * admin, the router and the clients' Workers for Platforms namespace need
 * before and around their first deploy, checked before it's created, so
 * running it again changes nothing that's there (GRA-283, GRA-430).
 *
 *   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node scripts/cloudflare-account-setup.ts [--dry-run]
 *
 * In order:
 * 1. the clients' dispatch namespace (`grasp-os-clients`), which the router
 *    and the admin bind;
 * 2. the admin's D1 database and R2 bucket, in the EU jurisdiction, and the
 *    router's hostname map (KV, which holds routing only), by the names the
 *    two wrangler.jsonc files and scripts/wrangler-deploy.ts look them up by;
 * 3. the account's one Secrets Store, and the names of the secrets the two
 *    Workers bind that it lacks: listed, never created, since a secret is
 *    created with its value, which an operator puts in themselves;
 * 4. on the clients' zone (`CLIENT_DOMAIN`, `ongrasp.app` unless set): a
 *    proxied wildcard record and the route `*.<domain>/*` to the router, the
 *    admin's custom domain (`ADMIN_HOST`, `admin.<domain>` unless set), and
 *    Email Routing on, its catch-all to the router.
 *
 * Step 4's route, custom domain and catch-all name a Worker, which must be
 * deployed first: until then each is reported pending, and running the
 * script again after the first deploy (deploy-ops) finishes them. The zone
 * itself isn't added: adding one means delegating its nameservers, which is
 * the domain owner's to do. Workers, Durable Objects, workflows and client
 * resources are deploys' and provisioning's, never this script's.
 *
 * It never reads, prints or writes a secret's value, nor the token: errors
 * name the call and Cloudflare's own codes. With `--dry-run` it only reads,
 * and says what it would create.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");

/** What a fresh account needs, by the names deploys look each up by. */
export const accountPlan = {
  /**
   * The clients' Workers for Platforms namespace (@grasp-os/shared/router,
   * `clientDispatchNamespace`, once GRA-283's router lands).
   */
  dispatchNamespace: "grasp-os-clients",
  /** The admin's database (apps/admin/wrangler.jsonc, `DB`). */
  d1: [{ name: "grasp-os-admin", jurisdiction: "eu" }],
  /** The admin's releases (apps/admin/wrangler.jsonc, `RELEASES`). */
  r2: [{ name: "grasp-os-releases", jurisdiction: "eu" }],
  /** The router's hostname map, by the title scripts/wrangler-deploy.ts finds. */
  kv: ["grasp-os-router-hosts"],
  /** The store's name, when the account has none yet. */
  secretsStore: "grasp-os",
  workers: { admin: "grasp-os-admin", router: "grasp-os-router" },
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
  | "missing";

/** One step's report: what, how it ended, and why, never a secret. */
export interface Report {
  step: string;
  outcome: Outcome;
  detail?: string;
}

/** A Cloudflare API call's answer, as far as the script reads it. */
interface Answer {
  status: number;
  success: boolean;
  result: unknown;
  errors: { code: number; message: string }[];
  totalPages: number;
}

/** What the script asks Cloudflare, as `fetch` would. */
export type Send = (request: Request) => Promise<Response>;

/** A refused call: its method, path, status and Cloudflare's codes. */
export class CloudflareCallError extends Error {
  constructor(method: string, pathname: string, answer: Answer) {
    const codes = answer.errors
      .map(({ code, message }) => `${code} ${message}`)
      .join("; ");
    super(`${method} ${pathname} failed (${answer.status}): ${codes}`);
    this.name = "CloudflareCallError";
  }
}

const base = "https://api.cloudflare.com/client/v4";

/** `value[key]` when value is an object, else undefined. */
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

const isList = (value: unknown): value is unknown[] => Array.isArray(value);

/** The Cloudflare API, as the script uses it, through `send`. */
const apiOf = (token: string, send: Send) => {
  const call = async (
    method: string,
    pathname: string,
    {
      json,
      headers = {},
    }: { json?: unknown; headers?: Record<string, string> } = {}
  ): Promise<Answer> => {
    const response = await send(
      new Request(`${base}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(json === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      })
    );
    const body: unknown = await response.json().catch(() => null);
    const errors = field(body, "errors");
    return {
      status: response.status,
      success: field(body, "success") === true,
      result: field(body, "result"),
      errors: isList(errors)
        ? errors.map((error) => ({
            code: Number(field(error, "code")),
            message: (() => {
              const message = field(error, "message");
              return typeof message === "string" ? message : "";
            })(),
          }))
        : [],
      totalPages: Number(field(field(body, "result_info"), "total_pages") ?? 1),
    };
  };
  /** `call`, refused unless it succeeded. */
  const ok = async (
    method: string,
    pathname: string,
    options?: Parameters<typeof call>[2]
  ): Promise<unknown> => {
    const answer = await call(method, pathname, options);
    if (!answer.success) {
      throw new CloudflareCallError(method, pathname, answer);
    }
    return answer.result;
  };
  /** Every item of a list, page by page. */
  const all = async (pathname: string): Promise<unknown[]> => {
    const items: unknown[] = [];
    const separator = pathname.includes("?") ? "&" : "?";
    for (let page = 1; ; page += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one page after another
      const answer = await call(
        "GET",
        `${pathname}${separator}page=${page}&per_page=100`
      );
      if (!answer.success) {
        throw new CloudflareCallError("GET", pathname, answer);
      }
      if (isList(answer.result)) {
        items.push(...answer.result);
      }
      if (!isList(answer.result) || page >= answer.totalPages) {
        return items;
      }
    }
  };
  return { call, ok, all };
};

type Api = ReturnType<typeof apiOf>;

/** What one run works with. */
export interface SetupOptions {
  accountId: string;
  token: string;
  /** The clients' zone: their hostnames are `<id>.<domain>`. */
  domain: string;
  /** The admin's hostname. */
  adminHost: string;
  dryRun: boolean;
  send: Send;
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

/** Steps 1 to 3: the namespace, the databases, buckets and map, the store. */
const accountSteps = async (
  api: Api,
  { accountId, dryRun, secrets }: SetupOptions,
  reports: Report[]
): Promise<void> => {
  const account = `/accounts/${accountId}`;
  const { dispatchNamespace } = accountPlan;
  await ensure(
    reports,
    `dispatch namespace ${dispatchNamespace}`,
    dryRun,
    async () =>
      namesOf(
        await api.all(`${account}/workers/dispatch/namespaces`),
        "namespace_name"
      ).includes(dispatchNamespace),
    async () => {
      await api.ok("POST", `${account}/workers/dispatch/namespaces`, {
        json: { name: dispatchNamespace },
      });
    }
  );
  for (const { name, jurisdiction } of accountPlan.d1) {
    // oxlint-disable-next-line no-await-in-loop -- one database at a time
    await ensure(
      reports,
      `D1 database ${name} (${jurisdiction})`,
      dryRun,
      async () => {
        const databases = await api.all(
          `${account}/d1/database?name=${encodeURIComponent(name)}`
        );
        const database = databases.find((each) => field(each, "name") === name);
        if (database === undefined) {
          return false;
        }
        const held = field(database, "jurisdiction");
        if (typeof held === "string" && held !== jurisdiction) {
          throw new Error(
            `D1 database ${name} exists in jurisdiction ${held}, not ${jurisdiction}: move it by hand`
          );
        }
        return true;
      },
      async () => {
        await api.ok("POST", `${account}/d1/database`, {
          json: { name, jurisdiction },
        });
      }
    );
  }
  for (const { name, jurisdiction } of accountPlan.r2) {
    const headers = { "cf-r2-jurisdiction": jurisdiction };
    // oxlint-disable-next-line no-await-in-loop -- one bucket at a time
    await ensure(
      reports,
      `R2 bucket ${name} (${jurisdiction})`,
      dryRun,
      async () => {
        const answer = await api.call("GET", `${account}/r2/buckets/${name}`, {
          headers,
        });
        if (answer.status === 404) {
          return false;
        }
        if (!answer.success) {
          throw new CloudflareCallError(
            "GET",
            `${account}/r2/buckets/${name}`,
            answer
          );
        }
        return true;
      },
      async () => {
        await api.ok("POST", `${account}/r2/buckets`, {
          json: { name },
          headers,
        });
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
          await api.all(`${account}/storage/kv/namespaces`),
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
        await api.ok("POST", `${account}/storage/kv/namespaces`, {
          json: { title },
        });
      }
    );
  }
  // The account's one store: scripts/wrangler-deploy.ts binds the only one.
  const stores = await api.all(`${account}/secrets_store/stores`);
  if (stores.length > 1) {
    throw new Error(
      `The account has ${stores.length} Secrets Stores: deploys bind the only one`
    );
  }
  let storeId: unknown = field(stores[0], "id");
  if (typeof storeId === "string") {
    reports.push({ step: "Secrets Store", outcome: "exists" });
  } else if (dryRun) {
    reports.push({ step: "Secrets Store", outcome: "would_create" });
  } else {
    const made = await api.ok("POST", `${account}/secrets_store/stores`, {
      json: { name: accountPlan.secretsStore },
    });
    storeId = field(made, "id");
    reports.push({ step: "Secrets Store", outcome: "created" });
  }
  const held =
    typeof storeId === "string"
      ? new Set(
          namesOf(
            await api.all(`${account}/secrets_store/stores/${storeId}/secrets`),
            "name"
          )
        )
      : new Set<string>();
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

/** Step 4: the zone's wildcard record, route, custom domain and Email Routing. */
const zoneSteps = async (
  api: Api,
  { accountId, domain, adminHost, dryRun }: SetupOptions,
  reports: Report[]
): Promise<void> => {
  const account = `/accounts/${accountId}`;
  const zones = await api.all(
    `/zones?name=${encodeURIComponent(domain)}&account.id=${accountId}`
  );
  const zone = zones.find((each) => field(each, "name") === domain);
  const zoneId = field(zone, "id");
  if (typeof zoneId !== "string") {
    reports.push({
      step: `zone ${domain}`,
      outcome: "pending",
      detail:
        "add the zone to this account and delegate its nameservers, then run again",
    });
    return;
  }
  reports.push({ step: `zone ${domain}`, outcome: "exists" });
  const zonePath = `/zones/${zoneId}`;
  const deployed = new Set(
    namesOf(await api.all(`${account}/workers/scripts`), "id")
  );
  const { admin, router } = accountPlan.workers;
  const wildcard = `*.${domain}`;

  await ensure(
    reports,
    `DNS record ${wildcard}`,
    dryRun,
    async () => {
      const records = await api.all(
        `${zonePath}/dns_records?name=${encodeURIComponent(wildcard)}`
      );
      return records.length > 0;
    },
    async () => {
      // Proxied, to no origin: only for the route to the router to apply.
      await api.ok("POST", `${zonePath}/dns_records`, {
        json: {
          type: "AAAA",
          name: wildcard,
          content: "100::",
          proxied: true,
          ttl: 1,
        },
      });
    }
  );

  const pattern = `${wildcard}/*`;
  const routes = await api.all(`${zonePath}/workers/routes`);
  const route = routes.find((each) => field(each, "pattern") === pattern);
  if (route !== undefined) {
    const to = field(route, "script");
    if (to !== router) {
      throw new Error(
        `Route ${pattern} goes to ${String(to)}, not ${router}: change it by hand`
      );
    }
    reports.push({ step: `route ${pattern}`, outcome: "exists" });
  } else if (!deployed.has(router)) {
    reports.push({
      step: `route ${pattern}`,
      outcome: "pending",
      detail: `deploy ${router}, then run again`,
    });
  } else if (dryRun) {
    reports.push({ step: `route ${pattern}`, outcome: "would_create" });
  } else {
    await api.ok("POST", `${zonePath}/workers/routes`, {
      json: { pattern, script: router },
    });
    reports.push({ step: `route ${pattern}`, outcome: "created" });
  }

  // The admin's own hostname: a custom domain, which takes precedence over
  // the wildcard route.
  const [domainEntry] = await api.all(
    `${account}/workers/domains?hostname=${encodeURIComponent(adminHost)}`
  );
  if (domainEntry !== undefined) {
    const service = field(domainEntry, "service");
    if (service !== admin) {
      throw new Error(
        `${adminHost} is ${String(service)}'s custom domain, not ${admin}: change it by hand`
      );
    }
    reports.push({ step: `custom domain ${adminHost}`, outcome: "exists" });
  } else if (!deployed.has(admin)) {
    reports.push({
      step: `custom domain ${adminHost}`,
      outcome: "pending",
      detail: `deploy ${admin}, then run again`,
    });
  } else if (dryRun) {
    reports.push({
      step: `custom domain ${adminHost}`,
      outcome: "would_create",
    });
  } else {
    await api.ok("PUT", `${account}/workers/domains`, {
      json: {
        hostname: adminHost,
        service: admin,
        zone_id: zoneId,
        environment: "production",
      },
    });
    reports.push({ step: `custom domain ${adminHost}`, outcome: "created" });
  }

  await ensure(
    reports,
    `Email Routing on ${domain}`,
    dryRun,
    async () =>
      field(await api.ok("GET", `${zonePath}/email/routing`), "enabled") ===
      true,
    async () => {
      // Turns it on with the MX and SPF records it needs.
      await api.ok("POST", `${zonePath}/email/routing/dns`, {
        json: { name: domain },
      });
    }
  );

  const catchAll = await api.call(
    "GET",
    `${zonePath}/email/routing/rules/catch_all`
  );
  const actions = field(catchAll.result, "actions");
  const toRouter =
    field(catchAll.result, "enabled") === true &&
    isList(actions) &&
    actions.some((action) => {
      const value = field(action, "value");
      return (
        field(action, "type") === "worker" &&
        isList(value) &&
        value.includes(router)
      );
    });
  // A catch-all that already sends mail somewhere else is someone's:
  // never repointed here, as a route or a custom domain isn't.
  const elsewhere =
    !toRouter &&
    field(catchAll.result, "enabled") === true &&
    isList(actions) &&
    actions.some((action) => field(action, "type") !== "drop");
  if (elsewhere) {
    throw new Error(
      `${domain}'s Email Routing catch-all sends mail somewhere other than ${router}: change it by hand`
    );
  }
  if (toRouter) {
    reports.push({ step: "Email Routing catch-all", outcome: "exists" });
  } else if (!deployed.has(router)) {
    reports.push({
      step: "Email Routing catch-all",
      outcome: "pending",
      detail: `deploy ${router}, then run again`,
    });
  } else if (dryRun) {
    reports.push({ step: "Email Routing catch-all", outcome: "would_create" });
  } else {
    await api.ok("PUT", `${zonePath}/email/routing/rules/catch_all`, {
      json: {
        actions: [{ type: "worker", value: [router] }],
        matchers: [{ type: "all" }],
        enabled: true,
        name: "Every client's mail, to the router",
      },
    });
    reports.push({ step: "Email Routing catch-all", outcome: "created" });
  }
};

/** Sets the account up as `options` says (see the header): each step's report, in order. */
export const setUpAccount = async (
  options: SetupOptions
): Promise<Report[]> => {
  const api = apiOf(options.token, options.send);
  const reports: Report[] = [];
  await accountSteps(api, options, reports);
  await zoneSteps(api, options, reports);
  return reports;
};

/** `name` from the environment, when it's set to something. */
const setting = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
};

/** `name` from the environment, or a clear stop. */
const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
};

if (import.meta.main) {
  const domain = setting("CLIENT_DOMAIN") ?? "ongrasp.app";
  const reports = await setUpAccount({
    accountId: required("CLOUDFLARE_ACCOUNT_ID"),
    token: required("CLOUDFLARE_API_TOKEN"),
    domain,
    adminHost: setting("ADMIN_HOST") ?? `admin.${domain}`,
    dryRun: process.argv.includes("--dry-run"),
    send: async (request) => await fetch(request),
    secrets: neededSecrets(),
  });
  for (const { step, outcome, detail } of reports) {
    console.log(
      `${outcome.padEnd(12)} ${step}${detail === undefined ? "" : `: ${detail}`}`
    );
  }
  if (
    reports.some(
      ({ outcome }) => outcome === "pending" || outcome === "missing"
    )
  ) {
    console.log(
      "Some steps wait on something: do what they say, then run this again."
    );
  }
}
