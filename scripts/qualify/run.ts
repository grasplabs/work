/**
 * The real-account qualification of Workers for Platforms (GRA-430), as a
 * repeatable run against Grasp's Cloudflare account, through the `cf` CLI
 * alone, signed in with its own login:
 *
 *   CLOUDFLARE_ACCOUNT_ID=<id> node scripts/qualify/run.ts <step>... [--live]
 *
 * The account comes from the environment (`op run --env-file <file> --`
 * puts it there from 1Password, if it's kept there); nothing is read from
 * the command line or written to the repo. A token in the environment is
 * removed before cf runs (cf.ts), so cf acts only as its login. The mail
 * spike also reads `QUAL_MAIL_FROM`, `QUAL_MAIL_TO` and optionally
 * `QUAL_MAIL_FOREIGN_FROM`.
 *
 * Without `--live` no write runs at all: each is recorded as planned;
 * reads still go to the account. Every resource the run writes
 * is named after its prefix (`--prefix`, `qual-<yyyymmdd>` by default),
 * and a write naming anything else is refused (cf.ts), so a run only ever
 * touches its own qualification resources. `preflight` refuses an account
 * holding anything it doesn't know (`knownName`): the run's and earlier
 * runs' (`qual-…`), and the platform's own and placed clients' (`grasp-…`,
 * as @grasp-os/shared/names names them), so a run never starts in an account it
 * wasn't meant for. The evidence, one JSON line per cf invocation and per
 * check, and the run's state (its generated keys and ids, mode 0600) go to
 * `--out`, by default a directory under the system's temporary directory.
 *
 * Every Worker is uploaded by `cf deploy --prebuilt` from Build Output the
 * run writes (workers.ts), with its secrets in a `--secrets-file` it
 * deletes once cf has read it.
 *
 * Steps, in the order a full run takes them (`all`):
 * - `preflight`: the Workers for Platforms entitlement, and the account's
 *   inventory, refused if it holds anything unknown.
 * - `namespace`: the run's dispatch namespace.
 * - `dispatcher`: an ordinary Worker on workers.dev that dispatches into
 *   the namespace, only with the run's dispatch key.
 * - `release`: a built release's core and connect (`--release <dir>`,
 *   from `vp run release:build`) uploaded as user Workers for two test
 *   clients, `a` and `b`, each with its own EU D1 databases and R2
 *   buckets, its Durable Objects, the Loader, and core's service binding
 *   to its own connect. A binding kind the upload refuses is recorded and
 *   left out of the next attempt, one at a time. Then core's health, as
 *   the router asks it, with each client's own router secret.
 * - `probes`: each client's probe (workers.ts): a SQLite Durable Object
 *   made in the EU jurisdiction, a sandboxed Loader isolate's network and
 *   Cache API, and a service binding between user Workers.
 * - `durability`: Workerflow's death fixture as a user Worker; a run
 *   killed while it sleeps, once by a new version and once by evicting its
 *   object, must finish with each completed effect exactly once.
 * - `attack`: client A's router secret and code against client B: B's
 *   core through the dispatcher, from outside and from inside A's
 *   namespace code, and an audit of every binding and Durable Object
 *   namespace each client's scripts have.
 * - `email`: the GRA-965 spike: whether a user Worker may have a
 *   `send_email` binding, and whether it sends, from the account's own
 *   domain and from another.
 * - `inventory`: the account's inventory after the run.
 * - `cleanup`: deletes every resource of the run's prefix.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import {
  deriveRouterSecret,
  routerSecretHeader,
} from "@grasp-os/shared/router";
import { z } from "zod";

import { derivedCoreConfig } from "../../apps/admin/src/deploy/core-config.ts";
import {
  clientAuthSecret,
  reservedSecretNames,
  workerSecrets,
} from "../../apps/admin/src/deploy/secrets.ts";
import { probeCore } from "../../apps/admin/src/hosting/probe.ts";
import {
  ASSETS_DIR,
  layOutWorker,
  MIGRATIONS_DIR,
  WORKER_DIR,
} from "../release/deploy-lib.ts";
import {
  CfError,
  cfCli,
  entriesOf,
  evidenceLog,
  isOwnName,
  knownName,
  lastLines,
  textField,
} from "./cf.ts";
import type { Evidence } from "./cf.ts";
import {
  bindingKeys,
  clientConfig,
  clientName,
  clientResourceName,
  dispatcherSource,
  dispatchKeyHeader,
  connectStandInSource,
  gatewaySource,
  mailSource,
  outputOf,
  ownObject,
  probeCompatibilityDate,
  probeSource,
  recorderSource,
  storageOf,
  targetHeader,
  writeBuildOutput,
} from "./workers.ts";
import type {
  BindingKey,
  OutputBinding,
  OutputModule,
  OutputWorker,
} from "./workers.ts";

const steps = [
  "preflight",
  "namespace",
  "dispatcher",
  "release",
  "probes",
  "durability",
  "attack",
  "email",
  "gateway",
  "inventory",
  "cleanup",
] as const;
type Step = (typeof steps)[number];

const clients = ["a", "b"] as const;
type Client = (typeof clients)[number];

/** The release's Workers, connect first: core binds it. */
const releaseApps = ["connect", "core"] as const;

/**
 * The binding kinds left out of a refused upload, one more each attempt:
 * first those the admin already refuses for placed clients, then the
 * ones this run qualifies. Workflows are always left out: a placed client
 * binds none.
 */
const fallbackOrder: readonly BindingKey[] = [
  "ai",
  "send_email",
  "version_metadata",
  "worker_loaders",
  "services",
];

/** Whether a wrangler.json binding entry binds anything: a non-empty list, or an object. */
const hasBindings = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.length > 0
    : typeof value === "object" && value !== null;

/** The binding kind a refusal's message names, when it names one. */
const refusedKinds: readonly [RegExp, BindingKey][] = [
  [/service binding/iu, "services"],
  [/send[_ ]?email/iu, "send_email"],
  [/version[_ ]metadata/iu, "version_metadata"],
  [/worker[_ ]loader/iu, "worker_loaders"],
  [/\bai\b|workers ai/iu, "ai"],
];

const refusedKind = (output: string): BindingKey | undefined =>
  refusedKinds.find(([pattern]) => pattern.test(output))?.[1];

/** How long a killed run may take to finish on its own. */
const resumeDeadlineMs = 4 * 60 * 1000;
/** How long the death fixture's run sleeps: time enough to kill it. */
const napMs = 45_000;
const pollMs = 2000;

const prefixPattern = /^qual-[a-z0-9-]{1,24}$/u;

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    live: { type: "boolean", default: false },
    prefix: { type: "string" },
    release: { type: "string" },
    out: { type: "string" },
  },
});

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
if (accountId === "") {
  throw new Error(
    "CLOUDFLARE_ACCOUNT_ID is not set: run with the account's id in the environment (op run --env-file <file> -- for a 1Password reference)"
  );
}
const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const prefix = args.prefix ?? `qual-${today}`;
if (!prefixPattern.test(prefix)) {
  throw new Error(`The prefix must match ${prefixPattern.source}`);
}
const asked = positionals.length === 0 ? ["preflight"] : positionals;
const chosen: Step[] = asked.includes("all")
  ? steps.filter((step) => step !== "cleanup")
  : asked.map((name) => {
      const step = steps.find((known) => known === name);
      if (step === undefined) {
        throw new Error(
          `Unknown step ${name}: one of ${steps.join(", ")}, all`
        );
      }
      return step;
    });

const outDir = path.resolve(
  args.out ?? path.join(tmpdir(), "grasp-qualify", prefix)
);
mkdirSync(outDir, { recursive: true, mode: 0o700 });
// Owner only, whatever it was: it holds the run's keys and evidence.
chmodSync(outDir, 0o700);
const evidenceFile = path.join(outDir, "evidence.jsonl");
const record = evidenceLog(evidenceFile);
if (existsSync(evidenceFile)) {
  chmodSync(evidenceFile, 0o600);
}
const cf = cfCli({ accountId, prefix, live: args.live, record });

const require = createRequire(import.meta.url);
const wranglerCli = path.join(
  path.dirname(require.resolve("wrangler/package.json")),
  "bin/wrangler.js"
);

/** What one step leaves for the next, kept between invocations. */
const stateSchema = z.object({
  dispatchKey: z.string(),
  routerKey: z.string(),
  clientKey: z.string(),
  dispatcherUrl: z.string().optional(),
  created: z.array(z.string()).default([]),
});
type State = z.infer<typeof stateSchema>;
const stateFile = path.join(outDir, "state.json");
const freshKey = (): string => randomBytes(32).toString("hex");
const state: State = existsSync(stateFile)
  ? stateSchema.parse(JSON.parse(readFileSync(stateFile, "utf-8")))
  : {
      dispatchKey: freshKey(),
      routerKey: freshKey(),
      clientKey: freshKey(),
      created: [],
    };
for (const id of state.created) {
  cf.own(id);
}
const saveState = (): void => {
  writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(stateFile, 0o600);
};
const own = (id: string): void => {
  cf.own(id);
  if (!state.created.includes(id)) {
    state.created.push(id);
    saveState();
  }
};
saveState();

/** A check's outcome, recorded and printed. */
const checks: { name: string; result: string }[] = [];
const check = (
  name: string,
  result: "pass" | "fail" | "observed" | "skipped",
  detail: Record<string, unknown> = {}
): void => {
  checks.push({ name, result });
  record({ kind: "check", name, result, ...detail });
  console.info(`${result.padEnd(8)} ${name}`);
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

// ---------------------------------------------------------------------------
// Inventory

/** Every name in the account the run could collide with, by kind. */
interface Inventory {
  scripts: string[];
  databases: string[];
  buckets: string[];
  euBuckets: string[];
  namespaces: string[];
}

const inventoryKinds: readonly (keyof Inventory)[] = [
  "scripts",
  "databases",
  "buckets",
  "euBuckets",
  "namespaces",
];

/** The names cf listed, by the first of `keys` each entry has. */
const namesIn = (
  result: unknown,
  keys: readonly string[],
  listKey?: string
): string[] =>
  entriesOf(result, listKey)
    .map((entry) => textField(entry, keys))
    .filter((name): name is string => name !== undefined)
    .toSorted((a, b) => a.localeCompare(b));

/** Page size of the paged listings: cf refuses more for some (d1 list). */
const pageSize = 100;

/** Every page of a paged cf listing `args`, entries together. */
const allPages = (listing: readonly string[]): unknown[] => {
  const entries: unknown[] = [];
  for (let page = 1; ; page += 1) {
    const found = entriesOf(
      cf.read([
        ...listing,
        "--per-page",
        String(pageSize),
        "--page",
        String(page),
      ])
    );
    entries.push(...found);
    if (found.length < pageSize) {
      return entries;
    }
  }
};

const inventory = (): Inventory => ({
  scripts: namesIn(allPages(["workers", "scripts", "search"]), [
    "script_name",
    "id",
    "name",
  ]),
  databases: namesIn(allPages(["d1", "list"]), ["name"]),
  buckets: namesIn(
    cf.read(["r2", "buckets", "list", "--per-page", "1000"]),
    ["name"],
    "buckets"
  ),
  euBuckets: namesIn(
    cf.read([
      "r2",
      "buckets",
      "list",
      "--per-page",
      "1000",
      "--cf-r2-jurisdiction",
      "eu",
    ]),
    ["name"],
    "buckets"
  ),
  namespaces: namesIn(
    cf.read(["workers-for-platforms", "dispatch-namespaces", "list"]),
    ["namespace_name", "name"]
  ),
});

const recordInventory = (label: string): Inventory => {
  const found = inventory();
  record({
    kind: "inventory",
    label,
    sha256: sha256(JSON.stringify(found)),
    found,
  });
  return found;
};

// ---------------------------------------------------------------------------
// Uploads

/** Where each uploaded Worker's Build Output is written. */
const projectDir = (name: string): string =>
  path.join(outDir, "projects", name);

interface DeployOptions {
  /** An ordinary Worker of the account, not a user Worker in the namespace. */
  ordinary?: boolean;
  secrets?: Readonly<Record<string, string>>;
  assetsFrom?: string;
}

/**
 * Uploads `worker` with `cf deploy --prebuilt`, into the run's namespace
 * unless `ordinary`, with `secrets` in a file cf reads and the run then
 * deletes. Answers cf's output: the deploy prints its URLs there.
 */
const deploy = (
  worker: Omit<OutputWorker, "manifest">,
  mainModule: string,
  modules: readonly OutputModule[],
  { ordinary = false, secrets = {}, assetsFrom }: DeployOptions = {}
): { planned: boolean; output: string } => {
  const dir = projectDir(worker.name);
  writeBuildOutput(dir, worker, mainModule, modules, assetsFrom);
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: worker.name, private: true })
  );
  const secretsFile = path.join(dir, "secrets.json");
  const hasSecrets = Object.keys(secrets).length > 0;
  if (hasSecrets) {
    writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
  }
  try {
    const { planned, output } = cf.write(
      [
        "deploy",
        "--prebuilt",
        ...(ordinary ? [] : ["--dispatch-namespace", prefix]),
        ...(hasSecrets ? ["--secrets-file", secretsFile] : []),
        "--message",
        `Qualification run ${prefix}`,
      ],
      { names: ordinary ? [worker.name] : [prefix, worker.name], cwd: dir }
    );
    return { planned, output };
  } finally {
    rmSync(secretsFile, { force: true });
  }
};

/** A Worker of one JavaScript module, as the probes are. */
const oneModule = (source: string): OutputModule[] => [
  { name: "index.js", type: "esm", content: source },
];

/** Through the dispatcher, to user Worker `script`. */
const dispatch = async (
  script: string,
  pathAndQuery: string,
  init: RequestInit = {}
): Promise<Response> => {
  if (state.dispatcherUrl === undefined) {
    throw new Error("Run the dispatcher step first");
  }
  const headers = new Headers(init.headers);
  headers.set(targetHeader, script);
  headers.set(dispatchKeyHeader, state.dispatchKey);
  return await fetch(`${state.dispatcherUrl}${pathAndQuery}`, {
    ...init,
    headers,
    redirect: "manual",
  });
};

const jsonOf = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { text: text.slice(0, 200) };
  }
};

// ---------------------------------------------------------------------------
// Steps

const preflight = (): void => {
  try {
    cf.read(["workers-for-platforms", "dispatch-namespaces", "list"]);
    check("account is entitled to Workers for Platforms", "pass");
  } catch (error) {
    check("account is entitled to Workers for Platforms", "fail", {
      error: errorText(error),
    });
    throw new Error("Workers for Platforms isn't enabled on this account", {
      cause: error,
    });
  }
  const found = recordInventory("before");
  const foreign = inventoryKinds.flatMap((kind) =>
    found[kind]
      .filter((name) => !knownName(name))
      .map((name) => `${kind}:${name}`)
  );
  check(
    "account holds only Grasp's and qualification resources",
    foreign.length === 0 ? "pass" : "fail",
    { foreign }
  );
  if (foreign.length > 0) {
    throw new Error(
      `Refused: the account isn't one this run knows, it holds ${foreign.join(", ")}`
    );
  }
};

const namespaceStep = (): void => {
  const existing = namesIn(
    cf.read(["workers-for-platforms", "dispatch-namespaces", "list"]),
    ["namespace_name", "name"]
  );
  if (existing.includes(prefix)) {
    check("dispatch namespace exists", "observed", { namespace: prefix });
    return;
  }
  const { planned } = cf.write(
    [
      "workers-for-platforms",
      "dispatch-namespaces",
      "create",
      "--name",
      prefix,
    ],
    { names: [prefix] }
  );
  check("dispatch namespace created", planned ? "skipped" : "pass", {
    namespace: prefix,
  });
};

/** A workers.dev address cf printed for `name`. */
const workersDevUrl = (output: string, name: string): string | undefined =>
  new RegExp(`https://${name}\\.[a-z0-9-]+\\.workers\\.dev`, "u").exec(
    output
  )?.[0];

/**
 * The durability check's outside world: the recorder as an ordinary
 * account Worker, which the death fixture reaches by a service binding
 * (one user Worker can't bind another: 10143, seen on the GRA-430 run).
 */
const outsideName = `${prefix}-outside`;

const dispatcherStep = (): void => {
  const name = `${prefix}-dispatcher`;
  deploy(
    {
      name: outsideName,
      compatibilityDate: probeCompatibilityDate,
      env: { EFFECTS_OBJECT: ownObject("Effects") },
      exports: { Effects: { type: "durable-object", storage: "sqlite" } },
    },
    "index.js",
    oneModule(recorderSource),
    { ordinary: true }
  );
  const { planned, output } = deploy(
    {
      name,
      compatibilityDate: probeCompatibilityDate,
      workersDev: true,
      previewUrls: false,
      env: {
        DISPATCHER: { type: "dispatch-namespace", namespace: prefix },
        OUTSIDE: { type: "worker", worker: outsideName },
      },
    },
    "index.js",
    oneModule(dispatcherSource(prefix)),
    { ordinary: true, secrets: { DISPATCH_KEY: state.dispatchKey } }
  );
  if (planned) {
    check("dispatcher uploaded", "skipped");
    return;
  }
  const url = workersDevUrl(output, name);
  if (url === undefined) {
    check("dispatcher uploaded", "fail", { reason: "no workers.dev address" });
    return;
  }
  state.dispatcherUrl = url;
  saveState();
  check("dispatcher uploaded", "pass", { url });
};

/** The id of the client's database `name`, created in the EU if it isn't there. */
const ensureDatabase = (name: string): string => {
  const found = entriesOf(cf.read(["d1", "list", "--name", name])).find(
    (entry) => textField(entry, ["name"]) === name
  );
  const existing = textField(found, ["uuid"]);
  if (existing !== undefined) {
    own(existing);
    return existing;
  }
  const { planned, result } = cf.write(
    ["d1", "create", "--name", name, "--jurisdiction", "eu"],
    { names: [name] }
  );
  const made = textField(result, ["uuid"]);
  if (!planned && made === undefined) {
    throw new Error(`cf created ${name} but answered no id for it`);
  }
  if (made === undefined) {
    // A dry run's stand-in: the run's own, for the writes planned on it.
    const standIn = `planned-${name}`;
    cf.own(standIn);
    return standIn;
  }
  own(made);
  return made;
};

/** The client's EU bucket `name`, created if it isn't there. */
const ensureBucket = (name: string): void => {
  const found = namesIn(
    cf.read([
      "r2",
      "buckets",
      "list",
      "--name-contains",
      name,
      "--cf-r2-jurisdiction",
      "eu",
    ]),
    ["name"],
    "buckets"
  );
  if (found.includes(name)) {
    return;
  }
  cf.write(
    ["r2", "buckets", "create", "--name", name, "--cf-r2-jurisdiction", "eu"],
    { names: [name] }
  );
};

/** Client `client`'s core script. */
const coreOf = (client: Client): string =>
  clientResourceName({ prefix, client }, "grasp-os-core");

/** The real connect gateway's script, for the run (apps/gateway, GRA-1217). */
const realGatewayName = `${prefix}-connect-gateway`;

/**
 * Uploads the repo's own connect gateway (apps/gateway), bundled on this
 * machine as Wrangler's dry run bundles it, as an ordinary Worker reaching
 * the run's namespace. Its script, or undefined in a checkout without the
 * gateway, where core's binding to connect is left out instead.
 */
const deployRealGateway = (): string | undefined => {
  const app = path.resolve("apps/gateway");
  if (!existsSync(path.join(app, "src", "index.ts"))) {
    return undefined;
  }
  const dir = path.join(outDir, "gateway-bundle");
  mkdirSync(dir, { recursive: true });
  execFileSync(
    process.execPath,
    [
      wranglerCli,
      "deploy",
      "--dry-run",
      "--outdir",
      dir,
      "--name",
      realGatewayName,
    ],
    { cwd: app, stdio: "pipe" }
  );
  const module = readdirSync(dir).find((file) => file.endsWith(".js"));
  if (module === undefined) {
    throw new Error("Bundling wrote no module for the connect gateway");
  }
  deploy(
    {
      name: realGatewayName,
      compatibilityDate: probeCompatibilityDate,
      env: { CLIENTS: { type: "dispatch-namespace", namespace: prefix } },
    },
    "index.js",
    oneModule(readFileSync(path.join(dir, module), "utf-8")),
    { ordinary: true }
  );
  return realGatewayName;
};

/** Client `client`'s id, as its core runs as and its secrets derive from. */
const clientIdOf = (client: Client): string =>
  clientName({ prefix, client }, "client");

/** Client `client`'s router secret, as the admin derives it. */
const routerSecretOf = async (client: Client): Promise<string> =>
  await deriveRouterSecret(state.routerKey, clientIdOf(client), 1);

type ReleaseWorker = Awaited<ReturnType<typeof layOutWorker>>["worker"];

/** `app`'s secrets for `client`, as the admin derives them. */
const secretsOf = async (
  client: Client,
  app: string,
  worker: ReleaseWorker
): Promise<Record<string, string>> => {
  const shared = Object.fromEntries(
    worker.requiredSecrets
      .filter((name) => !reservedSecretNames.has(name))
      .map((name) => [name, `qual-placeholder-${name.toLowerCase()}`])
  );
  const secrets = await workerSecrets(
    app,
    worker,
    {
      routerKey: state.routerKey,
      clientKey: state.clientKey,
      shared: { [app]: shared },
    },
    { id: clientIdOf(client), generation: 1, rotationLiveAt: null },
    new Date(),
    new Map()
  );
  return Object.fromEntries(secrets.map(({ name, value }) => [name, value]));
};

/** Core's vars for `client`, as the admin derives them; none for connect. */
const varsOf = (client: Client, app: string): Record<string, unknown> => {
  if (app !== "core") {
    return {};
  }
  const { MODEL_GATEWAY: _gateway, ...derived } = derivedCoreConfig({
    clientId: clientIdOf(client),
    signIn: null,
    domain: "qual.invalid",
    apps: {},
  });
  return derived;
};

/**
 * Uploads `app` of the release for `client` from the release's verified
 * bytes (deploy-lib.ts), its D1 migrations applied first, leaving out one
 * more binding kind after each refusal. Returns the kinds it went without,
 * or undefined when every attempt was refused.
 */
const deployReleaseWorker = async (
  releaseDir: string,
  client: Client,
  app: (typeof releaseApps)[number],
  apps: Record<string, string>,
  gateway: string | undefined
): Promise<ReadonlySet<BindingKey> | undefined> => {
  const dir = path.join(outDir, "release", client, app);
  const laidOut = await layOutWorker(releaseDir, app, dir);
  const original = z
    .looseObject({ name: z.string() })
    .parse(JSON.parse(readFileSync(laidOut.config, "utf-8")));
  const storage = storageOf(original);
  const databaseIds: Record<string, string> = {};
  for (const database of storage.databases) {
    databaseIds[database] = ensureDatabase(
      clientResourceName({ prefix, client }, database)
    );
  }
  for (const bucket of storage.buckets) {
    ensureBucket(clientResourceName({ prefix, client }, bucket));
  }
  for (const database of laidOut.worker.d1Databases) {
    const id = databaseIds[database.databaseName];
    if (id === undefined) {
      continue;
    }
    cf.write(
      [
        "d1",
        "migrations",
        "apply",
        id,
        "--dir",
        path.join(dir, MIGRATIONS_DIR, database.binding),
      ],
      { names: [id] }
    );
  }
  const secrets = await secretsOf(client, app, laidOut.worker);
  const modules: OutputModule[] = laidOut.worker.modules.map(
    ({ name, type }) => ({
      name,
      type,
      content: readFileSync(path.join(dir, WORKER_DIR, name)),
    })
  );
  const assetsDir = path.join(dir, ASSETS_DIR);
  const without = new Set<BindingKey>(["workflows"]);
  for (let attempt = 0; attempt <= fallbackOrder.length; attempt += 1) {
    const config = {
      ...clientConfig(original, {
        prefix,
        client,
        apps,
        databaseIds,
        without,
        ...(gateway === undefined ? {} : { gateway }),
      }),
      vars: varsOf(client, app),
    };
    try {
      const { planned } = deploy(
        outputOf(config),
        laidOut.worker.mainModule,
        modules,
        {
          secrets,
          ...(existsSync(assetsDir) ? { assetsFrom: assetsDir } : {}),
        }
      );
      check(
        `${client}: ${app} uploaded as a user Worker`,
        planned ? "skipped" : "pass",
        {
          script: config.name,
          without: [...without],
          bindings: bindingKeys.filter((key) =>
            hasBindings(Reflect.get(config, key))
          ),
          secrets: Object.keys(secrets),
        }
      );
      return without;
    } catch (error) {
      if (!(error instanceof CfError)) {
        throw error;
      }
      record({
        kind: "refused upload",
        script: config.name,
        without: [...without],
        error: lastLines(error.output),
      });
      const named = refusedKind(error.output);
      const next =
        named !== undefined &&
        !without.has(named) &&
        Object.hasOwn(original, named)
          ? named
          : fallbackOrder.find(
              (key) => !without.has(key) && Object.hasOwn(original, key)
            );
      if (next === undefined) {
        break;
      }
      without.add(next);
    }
  }
  check(`${client}: ${app} uploaded as a user Worker`, "fail");
  return undefined;
};

/** The release's directory: `--release`, or a fresh build into the run's directory. */
const releaseDirOf = (): string => {
  if (args.release !== undefined) {
    return path.resolve(args.release);
  }
  const dir = path.join(outDir, "release-build");
  if (!existsSync(path.join(dir, "manifest.json"))) {
    execFileSync(
      process.execPath,
      ["scripts/release/build-release.ts", "--out", dir],
      { stdio: "inherit" }
    );
  }
  return dir;
};

/**
 * The admin's own signed probe of client `client`'s core (apps/admin's
 * hosting/probe.ts), through the dispatcher: it arms connect's clock
 * through core's binding to connect, so its answer says whether core
 * reaches its own connect (through the gateway, in a namespace).
 */
const signedProbe = async (client: Client): Promise<void> => {
  const routerSecret = await routerSecretOf(client);
  const answer = await probeCore({
    origin: state.dispatcherUrl ?? "",
    routerSecret,
    authSecret: await clientAuthSecret(
      { routerKey: state.routerKey, clientKey: state.clientKey },
      clientIdOf(client),
      1
    ),
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set(targetHeader, coreOf(client));
      headers.set(dispatchKeyHeader, state.dispatchKey);
      return await fetch(input, { ...init, headers });
    },
    timeoutMs: 30_000,
  });
  check(
    `${client}: core reaches its own connect (the signed probe arms connect's clock)`,
    answer?.clocks.connect?.armed === true &&
      answer.clientId === clientIdOf(client) &&
      answer.bindings.CONNECT !== false
      ? "pass"
      : "fail",
    { answer: answer ?? null }
  );
};

const releaseStep = async (): Promise<void> => {
  const releaseDir = releaseDirOf();
  const manifestText = readFileSync(
    path.join(releaseDir, "manifest.json"),
    "utf-8"
  );
  const manifest = z
    .object({
      releaseId: z.string(),
      commit: z.string(),
      workers: z.record(z.string(), z.object({ name: z.string() }).loose()),
    })
    .parse(JSON.parse(manifestText));
  record({
    kind: "release",
    releaseId: manifest.releaseId,
    commit: manifest.commit,
    manifestSha256: sha256(manifestText),
  });
  const apps = Object.fromEntries(
    Object.entries(manifest.workers).map(([app, { name }]) => [name, app])
  );
  const gateway = deployRealGateway();
  check(
    "the connect gateway is the repo's own, reaching the run's namespace",
    gateway === undefined ? "skipped" : "pass",
    { gateway: gateway ?? null }
  );
  for (const client of clients) {
    for (const app of releaseApps) {
      // oxlint-disable-next-line no-await-in-loop -- connect before core, which binds it
      await deployReleaseWorker(releaseDir, client, app, apps, gateway);
    }
  }
  if (!args.live) {
    return;
  }
  for (const client of clients) {
    // oxlint-disable-next-line no-await-in-loop -- one client at a time
    const secret = await routerSecretOf(client);
    // oxlint-disable-next-line no-await-in-loop -- as above
    const answer = await dispatch(coreOf(client), "/health", {
      headers: { [routerSecretHeader]: secret },
    });
    // oxlint-disable-next-line no-await-in-loop -- as above
    const body = await jsonOf(answer);
    check(
      `${client}: core answers its health check`,
      answer.ok ? "pass" : "fail",
      { status: answer.status, body }
    );
  }
  for (const client of clients) {
    // oxlint-disable-next-line no-await-in-loop -- one client at a time
    await signedProbe(client);
  }
};

const probeName = (client: Client): string =>
  clientName({ prefix, client }, "probe");
const recorderName = `${prefix}-effects`;

/** Uploads the recorder; true unless only planned. */
const deployRecorder = (): boolean =>
  !deploy(
    {
      name: recorderName,
      compatibilityDate: probeCompatibilityDate,
      env: {
        EFFECTS_OBJECT: ownObject("Effects"),
      },
      exports: { Effects: { type: "durable-object", storage: "sqlite" } },
    },
    "index.js",
    oneModule(recorderSource)
  ).planned;

/** Uploads client `client`'s probe; true unless only planned. */
/**
 * Uploads client `client`'s probe; true unless only planned. With a
 * service binding to the recorder first; where the namespace refuses one
 * between user Workers, recorded, with a binding to the namespace itself
 * in its place.
 */
const deployProbe = (client: Client): boolean => {
  const name = probeName(client);
  const probe = (peer: Record<string, OutputBinding>) =>
    !deploy(
      {
        name,
        compatibilityDate: probeCompatibilityDate,
        env: {
          PROBE_OBJECT: ownObject("ProbeObject"),
          LOADER: { type: "worker-loader" },
          ...peer,
        },
        exports: {
          ProbeObject: { type: "durable-object", storage: "sqlite" },
        },
      },
      "index.js",
      oneModule(probeSource)
    ).planned;
  try {
    const uploaded = probe({ PEER: { type: "worker", worker: recorderName } });
    check(
      `${client}: a user Worker may have a service binding to another user Worker`,
      uploaded ? "pass" : "skipped"
    );
    return uploaded;
  } catch (error) {
    if (!(error instanceof CfError)) {
      throw error;
    }
    check(
      `${client}: a user Worker may have a service binding to another user Worker`,
      "fail",
      { error: lastLines(error.output) }
    );
    return probe({
      PEERS: { type: "dispatch-namespace", namespace: prefix },
      PEER_NAME: { type: "text", value: recorderName },
    });
  }
};

const probeChecks = async (client: Client): Promise<void> => {
  const probe = probeName(client);
  const object = await jsonOf(await dispatch(probe, "/object"));
  const placed = z
    .object({ jurisdiction: z.string().nullable(), sql: z.number() })
    .safeParse(object);
  check(
    `${client}: a SQLite Durable Object made in the EU jurisdiction`,
    placed.success && placed.data.jurisdiction === "eu" && placed.data.sql === 1
      ? "pass"
      : "fail",
    { answer: object }
  );
  const loader = await jsonOf(
    await dispatch(probe, "/loader?target=https%3A%2F%2Fexample.com%2F")
  );
  const sandboxed = z
    .object({ fetch: z.unknown(), cache: z.unknown(), env: z.number() })
    .safeParse(loader);
  check(
    `${client}: a sandboxed Loader isolate has no network, no Cache API and an empty env`,
    sandboxed.success &&
      typeof sandboxed.data.fetch === "string" &&
      sandboxed.data.cache !== "put" &&
      sandboxed.data.env === 0
      ? "pass"
      : "fail",
    { answer: loader }
  );
  const peer = await jsonOf(await dispatch(probe, "/peer"));
  check(
    `${client}: a user Worker reaches another user Worker in the namespace`,
    z
      .object({ status: z.literal(200) })
      .loose()
      .safeParse(peer).success
      ? "pass"
      : "fail",
    { answer: peer }
  );
};

const probesStep = async (): Promise<void> => {
  const uploaded = [deployRecorder(), ...clients.map(deployProbe)];
  if (uploaded.includes(false)) {
    check("probes uploaded", "skipped");
    return;
  }
  check("probes uploaded with a Durable Object and the Loader", "pass");
  for (const client of clients) {
    // oxlint-disable-next-line no-await-in-loop -- one client at a time
    await probeChecks(client);
  }
};

const durableName = `${prefix}-durable`;

/**
 * Workerflow's death fixture, bundled on this machine as its own harness
 * bundles it (packages/workerflow/test/process/workerd.ts): Wrangler's dry
 * run, which writes a file and reaches no account. Only cf uploads it.
 */
const bundledFixture = (): string => {
  const dir = path.join(outDir, "fixture");
  mkdirSync(dir, { recursive: true });
  execFileSync(
    process.execPath,
    [
      wranglerCli,
      "deploy",
      "test/death-fixture.ts",
      "--dry-run",
      "--outdir",
      dir,
      "--name",
      durableName,
      "--compatibility-date",
      probeCompatibilityDate,
      "--compatibility-flags",
      "nodejs_als",
    ],
    { cwd: path.resolve("packages/workerflow"), stdio: "pipe" }
  );
  const module = readdirSync(dir).find((file) => file.endsWith(".js"));
  if (module === undefined) {
    throw new Error("Bundling wrote no module for the death fixture");
  }
  return readFileSync(path.join(dir, module), "utf-8");
};

/** Uploads the death fixture; true unless only planned. */
const deployFixture = (source: string): boolean =>
  !deploy(
    {
      name: durableName,
      compatibilityDate: probeCompatibilityDate,
      compatibilityFlags: ["nodejs_als"],
      env: {
        RUNS: ownObject("Runs"),
        EFFECTS: { type: "worker", worker: outsideName },
      },
      exports: { Runs: { type: "durable-object", storage: "sqlite" } },
    },
    "index.js",
    oneModule(source)
  ).planned;

const effectRows = z.array(
  z.object({ run: z.string(), label: z.string(), key: z.string() }).loose()
);

const effectsOf = async (id: string) => {
  const answer = await dispatch(
    outsideName,
    `/list?run=${encodeURIComponent(id)}`
  );
  return effectRows.parse(await jsonOf(answer));
};

/** Waits until `ready` holds, polling, or throws at the deadline. */
const until = async (
  what: string,
  ready: () => Promise<boolean>
): Promise<void> => {
  const deadline = Date.now() + resumeDeadlineMs;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling
    if (await ready()) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- polling
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for ${what}`);
};

const runStatus = async (id: string): Promise<unknown> => {
  const answer = await dispatch(
    durableName,
    `/status?definition=napper&id=${id}`
  );
  return await jsonOf(answer);
};

/**
 * One napper run (a step, a sleep, a step) killed while it sleeps by
 * `kill`, which must finish on its own with each step's effect once.
 */
const killAndResume = async (
  how: string,
  kill: (id: string) => Promise<void>
): Promise<void> => {
  const id = `${how}-${Date.now()}`;
  const started = await dispatch(durableName, "/start", {
    method: "POST",
    body: JSON.stringify({ definition: "napper", id, params: { nap: napMs } }),
  });
  if (!started.ok) {
    check(`durability (${how}): run started`, "fail", {
      status: started.status,
      body: await jsonOf(started),
    });
    return;
  }
  try {
    await until("the first step's effect", async () => {
      const effects = await effectsOf(id);
      return effects.some(({ label }) => label === "before");
    });
    await kill(id);
    await until("the run to finish", async () => {
      const status = z
        .object({ status: z.string() })
        .loose()
        .safeParse(await runStatus(id));
      return (
        status.success && ["complete", "errored"].includes(status.data.status)
      );
    });
  } catch (error) {
    check(`durability (${how}): the run finished after the kill`, "fail", {
      error: errorText(error),
      effects: await effectsOf(id),
    });
    return;
  }
  const effects = await effectsOf(id);
  const count = (label: string) =>
    effects.filter((effect) => effect.label === label).length;
  check(
    `durability (${how}): finished, each completed effect once`,
    count("before") === 1 && count("after") === 1 ? "pass" : "fail",
    { effects, status: await runStatus(id) }
  );
};

const durabilityStep = async (): Promise<void> => {
  const source = bundledFixture();
  if (!deployFixture(source)) {
    check("durability fixture uploaded", "skipped");
    return;
  }
  check("durability fixture uploaded as a user Worker", "pass");
  // A new version of the script: workerd restarts its objects.
  await killAndResume("new-version", async () => {
    deployFixture(source);
    await Promise.resolve();
  });
  // The run object reset from inside (`ctx.abort`), as an eviction is.
  await killAndResume("evicted", async (id) => {
    await dispatch(durableName, `/evict?definition=napper&id=${id}`);
  });
};

/** Client `client`'s script `app`'s settings, as cf reads them; or the error. */
/** Client `client`'s script for `app`: a release Worker's, or its probe. */
const scriptOf = (client: Client, app: string): string =>
  app === "probe"
    ? clientName({ prefix, client }, app)
    : clientResourceName({ prefix, client }, `grasp-os-${app}`);

/** Whether `name` is one of client `client`'s scripts or resources. */
const ofClientNamed = (client: Client, name: string): boolean =>
  name.startsWith(`${prefix}-${client}-`) ||
  name.startsWith(clientResourceName({ prefix, client }, ""));

const settingsOf = (client: Client, app: string): unknown => {
  try {
    return cf.read([
      "workers-for-platforms",
      "dispatch-namespaces",
      "scripts",
      "settings",
      "get",
      scriptOf(client, app),
      "--dispatch-namespace",
      prefix,
    ]);
  } catch (error) {
    return { error: errorText(error) };
  }
};

const auditBindings = (): void => {
  for (const client of clients) {
    const other = clients.find((name) => name !== client) ?? client;
    const otherNames = [
      `${prefix}-${other}-`,
      clientResourceName({ prefix, client: other }, ""),
    ];
    for (const app of [...releaseApps, "probe"]) {
      const settings = settingsOf(client, app);
      const text = JSON.stringify(settings);
      check(
        `${client}: ${app}'s bindings name nothing of ${other}`,
        text.includes('"error"') ||
          otherNames.some((otherName) => text.includes(otherName))
          ? "fail"
          : "pass",
        { settings }
      );
    }
  }
  const objects = allPages(["durable-objects", "namespaces", "list"]);
  const ofClient = (client: Client) =>
    objects.filter((object) =>
      ofClientNamed(client, textField(object, ["script"]) ?? "")
    );
  const idsB = new Set(
    ofClient("b").map((object) => textField(object, ["id"]))
  );
  const shared = ofClient("a").filter((object) =>
    idsB.has(textField(object, ["id"]))
  );
  check(
    "a's and b's Durable Object namespaces are their own",
    ofClient("a").length > 0 && shared.length === 0 ? "pass" : "fail",
    { a: ofClient("a"), b: ofClient("b") }
  );
};

const attackStep = async (): Promise<void> => {
  if (!args.live) {
    check("attacks", "skipped");
    return;
  }
  const secretA = await routerSecretOf("a");
  const secretB = await routerSecretOf("b");
  const coreB = coreOf("b");
  const statusOf = async (secret?: string): Promise<number> => {
    const answer = await dispatch(coreB, "/health", {
      headers: secret === undefined ? {} : { [routerSecretHeader]: secret },
    });
    return answer.status;
  };
  const withB = await statusOf(secretB);
  const withA = await statusOf(secretA);
  const none = await statusOf();
  check(
    "b's core answers b's own router secret (control)",
    withB === 200 ? "pass" : "fail",
    { status: withB }
  );
  check("b's core refuses a's router secret", withA >= 400 ? "pass" : "fail", {
    status: withA,
  });
  check("b's core refuses no router secret", none >= 400 ? "pass" : "fail", {
    status: none,
  });
  // From inside a's namespace code: what a's code gets from b's core.
  const inside = await jsonOf(
    await dispatch(probeName("a"), "/reach", {
      method: "POST",
      body: JSON.stringify({
        url: `${state.dispatcherUrl}/health`,
        headers: {
          [targetHeader]: coreB,
          [dispatchKeyHeader]: state.dispatchKey,
          [routerSecretHeader]: secretA,
        },
      }),
    })
  );
  const reached = z.object({ status: z.number() }).safeParse(inside);
  check(
    "a's code inside the namespace can't get b's core with a's secret",
    reached.success && reached.data.status >= 400 ? "pass" : "fail",
    { answer: inside }
  );
  auditBindings();
};

/** Uploads the mail spike's Worker; null when cf refused the binding. */
const deployMail = (name: string, to: string | undefined): boolean | null => {
  try {
    return !deploy(
      {
        name,
        compatibilityDate: probeCompatibilityDate,
        env: {
          EMAIL: {
            type: "send-email",
            ...(to === undefined ? {} : { destinationAddress: to }),
          },
        },
      },
      "index.js",
      oneModule(mailSource)
    ).planned;
  } catch (error) {
    if (error instanceof CfError) {
      check("a user Worker may have a send_email binding", "fail", {
        error: lastLines(error.output),
      });
      return null;
    }
    throw error;
  }
};

const emailStep = async (): Promise<void> => {
  const name = `${prefix}-mail`;
  const to = process.env.QUAL_MAIL_TO;
  const uploaded = deployMail(name, to);
  if (uploaded === null) {
    return;
  }
  if (!uploaded) {
    check("a user Worker may have a send_email binding", "skipped");
    return;
  }
  check("a user Worker may have a send_email binding", "pass");
  const from = process.env.QUAL_MAIL_FROM;
  if (from === undefined || to === undefined) {
    check("send_email sends from a user Worker", "skipped", {
      reason: "QUAL_MAIL_FROM and QUAL_MAIL_TO aren't set",
    });
    return;
  }
  const send = async (sender: string) =>
    await jsonOf(
      await dispatch(name, "/send", {
        method: "POST",
        body: JSON.stringify({ from: sender, to }),
      })
    );
  const fromOwn = await send(from);
  check(
    "send_email sends from the account's own domain",
    z.object({ sent: z.literal(true) }).safeParse(fromOwn).success
      ? "pass"
      : "fail",
    { answer: fromOwn }
  );
  const foreign = process.env.QUAL_MAIL_FOREIGN_FROM;
  if (foreign !== undefined) {
    check("send_email from a domain outside the account", "observed", {
      answer: await send(foreign),
    });
  }
};

/**
 * Empties the run's EU bucket `name` (what the clients' cores wrote to it
 * while they ran), a page of keys at a time, so it can be deleted.
 */
const emptyBucket = (name: string): void => {
  for (;;) {
    const keys = entriesOf(
      cf.read([
        "r2",
        "objects",
        "list",
        "--bucket-name",
        name,
        "--cf-r2-jurisdiction",
        "eu",
        "--per-page",
        "1000",
      ])
    )
      .map((entry) => textField(entry, ["key"]))
      .filter((key): key is string => key !== undefined);
    if (keys.length === 0) {
      return;
    }
    cf.write(
      [
        "r2",
        "objects",
        "bulk-delete",
        "--bucket-name",
        name,
        "--cf-r2-jurisdiction",
        "eu",
        "--body",
        JSON.stringify(keys),
        "--force",
      ],
      { names: [name] }
    );
  }
};

/**
 * The connect gateway (workers.ts): an ordinary Worker reaching the
 * namespace, bound by each client's probe through a service binding whose
 * props name that client's connect stand-in. Each probe must reach its own
 * connect, over fetch and RPC, and get its own even when it asks for the
 * other client's by name.
 */
const gatewayName = `${prefix}-gateway`;
const standInOf = (client: Client): string =>
  clientName({ prefix, client }, "connect-stand-in");
const gatewayProbeOf = (client: Client): string =>
  clientName({ prefix, client }, "gateway-probe");

/**
 * Uploads the gateway, each client's connect stand-in and each client's
 * probe bound to the gateway with props naming its stand-in. True when
 * all are live; false when planned or refused (recorded).
 */
const deployGateway = (): boolean => {
  let live = !deploy(
    {
      name: gatewayName,
      compatibilityDate: probeCompatibilityDate,
      env: { CLIENTS: { type: "dispatch-namespace", namespace: prefix } },
    },
    "index.js",
    oneModule(gatewaySource),
    { ordinary: true }
  ).planned;
  for (const client of clients) {
    const standIn = standInOf(client);
    live =
      !deploy(
        { name: standIn, compatibilityDate: probeCompatibilityDate },
        "index.js",
        oneModule(connectStandInSource(standIn))
      ).planned && live;
    const name = `${client}: a user Worker may bind the gateway with props naming its connect`;
    try {
      live =
        !deploy(
          {
            name: gatewayProbeOf(client),
            compatibilityDate: probeCompatibilityDate,
            env: {
              CONNECT: {
                type: "worker",
                worker: gatewayName,
                props: { script: standIn },
              },
            },
          },
          "index.js",
          oneModule(probeSource)
        ).planned && live;
      check(name, live ? "pass" : "skipped");
    } catch (error) {
      if (!(error instanceof CfError)) {
        throw error;
      }
      check(name, "fail", { error: lastLines(error.output) });
      return false;
    }
  }
  return live;
};

const gatewayAnswerSchema = z
  .object({
    fetched: z.string(),
    rpc: z.string(),
    asked: z.string(),
    call: z.string(),
    stream: z.string(),
  })
  .loose();

/** What client `client`'s probe gets through the gateway, asking for the other's connect by name. */
const throughGateway = async (client: Client): Promise<unknown> => {
  const other = clients.find((name) => name !== client) ?? client;
  // A new binding takes a few seconds to reach every location: asked
  // again until it answers, for at most half a minute.
  let answer: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- tries in turn
    const response = await dispatch(
      gatewayProbeOf(client),
      `/gateway?other=${encodeURIComponent(standInOf(other))}`
    );
    // oxlint-disable-next-line no-await-in-loop -- as above
    answer = await jsonOf(response);
    const parsed = gatewayAnswerSchema.safeParse(answer);
    if (parsed.success && parsed.data.rpc === standInOf(client)) {
      return answer;
    }
    // oxlint-disable-next-line no-await-in-loop -- waits between tries
    await sleep(5000);
  }
  return answer;
};

/**
 * The connect gateway (workers.ts): an ordinary Worker reaching the
 * namespace, bound by each client's probe through a service binding whose
 * props name that client's connect stand-in. Each probe must reach its own
 * connect, over fetch and forwarded RPC, and get its own even when it asks
 * for the other client's by name.
 */
const gatewayStep = async (): Promise<void> => {
  if (!deployGateway()) {
    return;
  }
  for (const client of clients) {
    const ownConnect = standInOf(client);
    // oxlint-disable-next-line no-await-in-loop -- one client at a time
    const answer = await throughGateway(client);
    const reached = gatewayAnswerSchema.safeParse(answer);
    check(
      `${client}: reaches only its own connect through the gateway, by fetch, RPC and a stream, whatever it asks`,
      reached.success &&
        [
          reached.data.fetched,
          reached.data.rpc,
          reached.data.asked,
          reached.data.call,
          reached.data.stream,
        ].every((reply) => reply === ownConnect)
        ? "pass"
        : "fail",
      { answer }
    );
    let settings: unknown;
    try {
      settings = cf.read([
        "workers-for-platforms",
        "dispatch-namespaces",
        "scripts",
        "settings",
        "get",
        gatewayProbeOf(client),
        "--dispatch-namespace",
        prefix,
      ]);
    } catch (error) {
      settings = { error: errorText(error) };
    }
    // The binding's props aren't in what Cloudflare reports: core's code
    // gets the binding, never the props.
    check(`${client}: the gateway binding as Cloudflare keeps it`, "observed", {
      settings,
    });
  }
};

/** Deletes every user Worker in the run's namespace. */
const deleteUserWorkers = (): void => {
  const scripts = namesIn(
    cf.read([
      "workers-for-platforms",
      "dispatch-namespaces",
      "scripts",
      "list",
      "--dispatch-namespace",
      prefix,
    ]),
    ["id", "script_name", "name"]
  );
  for (const script of scripts) {
    cf.write(
      [
        "workers-for-platforms",
        "dispatch-namespaces",
        "scripts",
        "delete",
        script,
        "--dispatch-namespace",
        prefix,
        "--force",
      ],
      { names: [prefix, script] }
    );
  }
};

const cleanupStep = (): void => {
  if (!args.live) {
    check("cleanup", "skipped");
    return;
  }
  const found = inventory();
  const ours = (names: readonly string[]) =>
    names.filter((name) => isOwnName(name, prefix));
  if (found.namespaces.includes(prefix)) {
    deleteUserWorkers();
  }
  // The dispatcher first: it binds the namespace and the outside world.
  const scripts = ours(found.scripts).toSorted(
    (x, y) =>
      Number(y.endsWith("-dispatcher")) - Number(x.endsWith("-dispatcher"))
  );
  for (const name of scripts) {
    cf.write(["workers", "delete", name, "--force"], { names: [name] });
  }
  for (const name of ours(found.namespaces)) {
    cf.write(
      [
        "workers-for-platforms",
        "dispatch-namespaces",
        "delete",
        name,
        "--force",
      ],
      { names: [name] }
    );
  }
  for (const database of allPages(["d1", "list"])) {
    const name = textField(database, ["name"]);
    const uuid = textField(database, ["uuid"]);
    if (name !== undefined && isOwnName(name, prefix) && uuid !== undefined) {
      own(uuid);
      cf.write(["d1", "delete", uuid, "--force"], { names: [uuid] });
    }
  }
  for (const name of ours(found.euBuckets)) {
    emptyBucket(name);
    cf.write(
      [
        "r2",
        "buckets",
        "delete",
        name,
        "--cf-r2-jurisdiction",
        "eu",
        "--force",
      ],
      {
        names: [name],
      }
    );
  }
  const after = recordInventory("after cleanup");
  const left = inventoryKinds
    .flatMap((kind) => after[kind])
    .filter((name) => isOwnName(name, prefix));
  check("nothing of the run is left", left.length === 0 ? "pass" : "fail", {
    left,
  });
  // The run's generated keys go with what they keyed.
  if (left.length === 0) {
    rmSync(stateFile, { force: true });
  }
};

const run: Record<Step, () => Promise<void> | void> = {
  preflight,
  namespace: namespaceStep,
  dispatcher: dispatcherStep,
  release: releaseStep,
  probes: probesStep,
  durability: durabilityStep,
  attack: attackStep,
  email: emailStep,
  gateway: gatewayStep,
  inventory: () => {
    recordInventory("after");
  },
  cleanup: cleanupStep,
};

record({
  kind: "run",
  prefix,
  live: args.live,
  steps: chosen,
  accountSha256: sha256(accountId),
});
console.info(
  `Qualification run ${prefix}${args.live ? "" : " (dry run: writes are only planned)"}; evidence in ${outDir}`
);
// Preflight first, always: nothing writes to an account it refuses.
const order = chosen.includes("preflight")
  ? chosen
  : (["preflight", ...chosen] satisfies Step[]);
for (const step of order) {
  record({ kind: "step", step } satisfies Evidence);
  // oxlint-disable-next-line no-await-in-loop -- steps run in order
  await run[step]();
}
const failed = checks.filter(({ result }) => result === "fail");
console.info(
  `${checks.length} checks: ${failed.length} failed. Evidence: ${path.join(outDir, "evidence.jsonl")}`
);
if (failed.length > 0) {
  process.exitCode = 1;
}
