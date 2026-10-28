/**
 * The real-account qualification of Workers for Platforms (GRA-430), as a
 * repeatable run against a disposable Cloudflare account:
 *
 *   op run --env-file qualify.env -- node scripts/qualify/run.ts <step>... [--live]
 *
 * where `qualify.env`, outside the repo, holds 1Password references, never
 * values: `CLOUDFLARE_ACCOUNT_ID=op://…` and `CLOUDFLARE_API_TOKEN=op://…`
 * (and, for the mail spike, `QUAL_MAIL_FROM`, `QUAL_MAIL_TO` and
 * optionally `QUAL_MAIL_FOREIGN_FROM`). Nothing is read from the command
 * line or written to the repo.
 *
 * Without `--live` every write is only planned and recorded; reads still
 * go to the account. Every resource the run writes is named after its
 * prefix (`--prefix`, `qual-<yyyymmdd>` by default), the API client
 * refuses any write that names something else (cloudflare.ts), and
 * `preflight` refuses an account holding anything not named `qual-…`, so a
 * run can only ever touch a disposable account's own qualification
 * resources. The evidence, one JSON line per call and per check, and the
 * run's state (the generated keys and ids, mode 0600) go to `--out`, by
 * default a directory under the system's temporary directory.
 *
 * Steps, in the order a full run takes them (`all`):
 * - `preflight`: the token, the account, the Workers for Platforms
 *   entitlement, and the account's inventory, refused unless disposable.
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
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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
  reservedSecretNames,
  workerSecrets,
} from "../../apps/admin/src/deploy/secrets.ts";
import { layOutWorker } from "../release/deploy-lib.ts";
import {
  cloudflareApi,
  CloudflareError,
  evidenceLog,
  plannedWriteError,
  verifyToken,
} from "./cloudflare.ts";
import type { Evidence } from "./cloudflare.ts";
import {
  bindingKeys,
  clientConfig,
  clientName,
  dispatcherSource,
  dispatchKeyHeader,
  mailSource,
  probeCompatibilityDate,
  probeSource,
  recorderSource,
  storageOf,
  targetHeader,
} from "./workers.ts";
import type { BindingKey, UploadMetadata } from "./workers.ts";

const steps = [
  "preflight",
  "namespace",
  "dispatcher",
  "release",
  "probes",
  "durability",
  "attack",
  "email",
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
 * ones this run qualifies.
 */
const fallbackOrder: readonly BindingKey[] = [
  "ai",
  "workflows",
  "send_email",
  "version_metadata",
  "worker_loaders",
  "services",
];

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

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `${name} is not set: run through \`op run --env-file <file> --\` with 1Password references`
    );
  }
  return value;
};

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

const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
const token = requiredEnv("CLOUDFLARE_API_TOKEN");
const outDir = path.resolve(
  args.out ?? path.join(tmpdir(), "grasp-qualify", prefix)
);
mkdirSync(outDir, { recursive: true, mode: 0o700 });
const record = evidenceLog(path.join(outDir, "evidence.jsonl"));
const api = cloudflareApi({
  accountId,
  token,
  prefix,
  live: args.live,
  record,
});

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
  api.own(id);
}
const saveState = (): void => {
  writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
};
const own = (id: string): void => {
  api.own(id);
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

/** `work`, or what a dry run planned instead of it. */
const orPlanned = async <T>(work: () => Promise<T>): Promise<T | "planned"> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Error && error.name === plannedWriteError) {
      return "planned";
    }
    throw error;
  }
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const namedList = z.array(z.object({ name: z.string() }).loose());

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

const sortedNames = (list: readonly { name: string }[]): string[] =>
  list.map(({ name }) => name).toSorted((a, b) => a.localeCompare(b));

const inventory = async (): Promise<Inventory> => {
  const scripts = await api.call(
    { method: "GET", path: "/workers/scripts" },
    z.array(z.object({ id: z.string() }).loose())
  );
  const databases = await api.call(
    { method: "GET", path: "/d1/database?per_page=10000" },
    namedList
  );
  const bucketsSchema = z.object({ buckets: namedList });
  const buckets = await api.call(
    { method: "GET", path: "/r2/buckets" },
    bucketsSchema
  );
  const euBuckets = await api.call(
    {
      method: "GET",
      path: "/r2/buckets",
      headers: { "cf-r2-jurisdiction": "eu" },
    },
    bucketsSchema
  );
  const namespaces = await api
    .call({ method: "GET", path: "/workers/dispatch/namespaces" }, namedList)
    .catch(() => []);
  return {
    scripts: scripts.map(({ id }) => id).toSorted((a, b) => a.localeCompare(b)),
    databases: sortedNames(databases),
    buckets: sortedNames(buckets.buckets),
    euBuckets: sortedNames(euBuckets.buckets),
    namespaces: sortedNames(namespaces),
  };
};

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const recordInventory = async (label: string) => {
  const found = await inventory();
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

const userPath = (script: string): string =>
  `/workers/dispatch/namespaces/${prefix}/scripts/${script}`;

/** Uploads one Worker of plain modules (no bundling) to `scriptPath`. */
const uploadScript = async (
  scriptPath: string,
  metadata: UploadMetadata,
  modules: Readonly<Record<string, string>>
): Promise<void> => {
  const form = new FormData();
  form.set(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" })
  );
  for (const [name, source] of Object.entries(modules)) {
    form.set(
      name,
      new File([source], name, { type: "application/javascript+module" })
    );
  }
  await api.call({ method: "PUT", path: scriptPath, form }, z.unknown());
};

const require = createRequire(import.meta.url);
const wranglerCli = path.join(
  path.dirname(require.resolve("wrangler/package.json")),
  "bin/wrangler.js"
);

/**
 * Runs Wrangler with the run's credentials (it reads them from the same
 * environment). Its output is kept out of the evidence: only whether it
 * succeeded, and its last line when it didn't.
 */
const wrangler = (
  wranglerArgs: readonly string[],
  cwd: string = process.cwd()
): { ok: boolean; output: string } => {
  try {
    const output = execFileSync(
      process.execPath,
      [wranglerCli, ...wranglerArgs],
      {
        cwd,
        stdio: "pipe",
        encoding: "utf-8",
        timeout: 10 * 60 * 1000,
      }
    );
    return { ok: true, output };
  } catch (error) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? String(error.stderr)
        : errorText(error);
    return { ok: false, output: stderr };
  }
};

/** The last non-empty lines of Wrangler's output, for the evidence. */
const tail = (output: string): string =>
  output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-3)
    .join(" | ");

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

const preflight = async (): Promise<void> => {
  const verified = await verifyToken(token);
  check("token is active", verified.status === "active" ? "pass" : "fail", {
    status: verified.status,
  });
  try {
    await api.call(
      { method: "GET", path: "/workers/dispatch/namespaces" },
      z.unknown()
    );
    check("account is entitled to Workers for Platforms", "pass");
  } catch (error) {
    check("account is entitled to Workers for Platforms", "fail", {
      error: errorText(error),
    });
    throw new Error("Workers for Platforms isn't enabled on this account", {
      cause: error,
    });
  }
  const found = await recordInventory("before");
  const foreign = inventoryKinds.flatMap((kind) =>
    found[kind]
      .filter((name) => !name.startsWith("qual-"))
      .map((name) => `${kind}:${name}`)
  );
  check(
    "account holds nothing but qualification resources",
    foreign.length === 0 ? "pass" : "fail",
    { foreign }
  );
  if (foreign.length > 0) {
    throw new Error(
      `Refused: the account isn't disposable, it holds ${foreign.join(", ")}`
    );
  }
};

const namespaceStep = async (): Promise<void> => {
  const existing = await api.call(
    { method: "GET", path: "/workers/dispatch/namespaces" },
    namedList
  );
  if (existing.some(({ name }) => name === prefix)) {
    check("dispatch namespace exists", "observed", { namespace: prefix });
    return;
  }
  const made = await orPlanned(
    async () =>
      await api.call(
        {
          method: "POST",
          path: "/workers/dispatch/namespaces",
          json: { name: prefix },
        },
        z.object({ namespace_id: z.string() }).loose(),
        { creates: prefix }
      )
  );
  check("dispatch namespace created", made === "planned" ? "skipped" : "pass", {
    namespace: prefix,
  });
};

const dispatcherStep = async (): Promise<void> => {
  const name = `${prefix}-dispatcher`;
  const uploaded = await orPlanned(async () => {
    await uploadScript(
      `/workers/scripts/${name}`,
      {
        main_module: "dispatcher.js",
        compatibility_date: probeCompatibilityDate,
        bindings: [
          { type: "dispatch_namespace", name: "DISPATCHER", namespace: prefix },
          {
            type: "secret_text",
            name: "DISPATCH_KEY",
            text: state.dispatchKey,
          },
        ],
      },
      { "dispatcher.js": dispatcherSource(prefix) }
    );
    await api.call(
      {
        method: "POST",
        path: `/workers/scripts/${name}/subdomain`,
        json: { enabled: true, previews_enabled: false },
      },
      z.unknown()
    );
  });
  if (uploaded === "planned") {
    check("dispatcher uploaded", "skipped");
    return;
  }
  const { subdomain } = await api.call(
    { method: "GET", path: "/workers/subdomain" },
    z.object({ subdomain: z.string() })
  );
  state.dispatcherUrl = `https://${name}.${subdomain}.workers.dev`;
  saveState();
  check("dispatcher uploaded", "pass", { url: state.dispatcherUrl });
};

/** The id of the client's database `name`, created in the EU if it isn't there. */
const ensureDatabase = async (name: string): Promise<string> => {
  const found = await api.call(
    { method: "GET", path: `/d1/database?name=${encodeURIComponent(name)}` },
    z.array(z.object({ name: z.string(), uuid: z.string() }).loose())
  );
  const existing = found.find((database) => database.name === name);
  if (existing !== undefined) {
    own(existing.uuid);
    return existing.uuid;
  }
  const made = await orPlanned(
    async () =>
      await api.call(
        {
          method: "POST",
          path: "/d1/database",
          json: { name, jurisdiction: "eu" },
        },
        z.object({ uuid: z.string() }).loose(),
        { creates: name }
      )
  );
  if (made === "planned") {
    return `planned-${name}`;
  }
  own(made.uuid);
  return made.uuid;
};

/** The client's EU bucket `name`, created if it isn't there. */
const ensureBucket = async (name: string): Promise<void> => {
  await orPlanned(async () => {
    try {
      await api.call(
        {
          method: "POST",
          path: "/r2/buckets",
          json: { name },
          headers: { "cf-r2-jurisdiction": "eu" },
        },
        z.unknown(),
        { creates: name }
      );
    } catch (error) {
      // Already there: one of the run's, from an earlier invocation.
      if (!(error instanceof CloudflareError && error.status === 409)) {
        throw error;
      }
    }
  });
};

/** Client `client`'s id, as its core runs as and its secrets derive from. */
const clientIdOf = (client: Client): string =>
  clientName({ prefix, client }, "client");

/** Client `client`'s router secret, as the admin derives it. */
const routerSecretOf = async (client: Client): Promise<string> =>
  await deriveRouterSecret(state.routerKey, clientIdOf(client), 1);

/** Puts `app`'s secrets on `script`, as the admin derives them. */
const deliverSecrets = async (
  client: Client,
  app: string,
  script: string,
  worker: Awaited<ReturnType<typeof layOutWorker>>["worker"]
): Promise<void> => {
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
  for (const { name, value } of secrets) {
    // oxlint-disable-next-line no-await-in-loop -- one secret at a time
    await api.call(
      {
        method: "PUT",
        path: `${userPath(script)}/secrets`,
        json: { name, text: value, type: "secret_text" },
      },
      z.unknown()
    );
  }
  check(`${client}: ${app} has its secrets`, "pass", {
    names: secrets.map(({ name }) => name),
  });
};

/**
 * Uploads `app` of the release for `client` with Wrangler, from the
 * release's verified bytes (deploy-lib.ts), leaving out one more binding
 * kind after each refusal. Returns the kinds it went without, or
 * undefined when every attempt was refused.
 */
const deployReleaseWorker = async (
  releaseDir: string,
  client: Client,
  app: (typeof releaseApps)[number],
  apps: Record<string, string>
): Promise<ReadonlySet<BindingKey> | undefined> => {
  const dir = path.join(outDir, "release", client, app);
  const laidOut = await layOutWorker(releaseDir, app, dir);
  const original = z
    .looseObject({ name: z.string() })
    .parse(JSON.parse(readFileSync(laidOut.config, "utf-8")));
  const storage = storageOf(original);
  const databaseIds: Record<string, string> = {};
  for (const database of storage.databases) {
    // oxlint-disable-next-line no-await-in-loop -- a few, in turn
    databaseIds[database] = await ensureDatabase(
      clientName({ prefix, client }, database)
    );
  }
  for (const bucket of storage.buckets) {
    // oxlint-disable-next-line no-await-in-loop -- a few, in turn
    await ensureBucket(clientName({ prefix, client }, bucket));
  }
  const vars =
    app === "core"
      ? (() => {
          const { MODEL_GATEWAY: _gateway, ...derived } = derivedCoreConfig({
            clientId: clientIdOf(client),
            signIn: null,
            domain: "qual.invalid",
            apps: {},
          });
          return derived;
        })()
      : {};
  const without = new Set<BindingKey>();
  for (let attempt = 0; attempt <= fallbackOrder.length; attempt += 1) {
    const config = {
      ...clientConfig(original, {
        prefix,
        client,
        apps,
        databaseIds,
        without,
      }),
      vars,
    };
    writeFileSync(laidOut.config, JSON.stringify(config, null, 2));
    const script = config.name;
    if (!args.live) {
      record({ kind: "planned", method: "wrangler deploy", path: script });
      check(`${client}: ${app} uploaded as a user Worker`, "skipped");
      return without;
    }
    for (const database of laidOut.worker.d1Databases) {
      const migrated = wrangler([
        "d1",
        "migrations",
        "apply",
        database.binding,
        "--remote",
        "--config",
        laidOut.config,
      ]);
      record({
        kind: "wrangler",
        what: "d1 migrations apply",
        script,
        database: database.binding,
        ok: migrated.ok,
        ...(migrated.ok ? {} : { error: tail(migrated.output) }),
      });
    }
    const deployed = wrangler([
      "deploy",
      "--config",
      laidOut.config,
      "--dispatch-namespace",
      prefix,
    ]);
    record({
      kind: "wrangler",
      what: "deploy",
      script,
      without: [...without],
      ok: deployed.ok,
      ...(deployed.ok ? {} : { error: tail(deployed.output) }),
    });
    if (deployed.ok) {
      check(`${client}: ${app} uploaded as a user Worker`, "pass", {
        script,
        without: [...without],
        bindings: bindingKeys.filter((key) => Object.hasOwn(config, key)),
      });
      // oxlint-disable-next-line no-await-in-loop -- once, on the attempt that succeeded
      await deliverSecrets(client, app, script, laidOut.worker);
      return without;
    }
    const next = fallbackOrder.find(
      (key) => !without.has(key) && original[key] !== undefined
    );
    if (next === undefined) {
      break;
    }
    without.add(next);
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
  for (const client of clients) {
    for (const app of releaseApps) {
      // oxlint-disable-next-line no-await-in-loop -- connect before core, which binds it
      await deployReleaseWorker(releaseDir, client, app, apps);
    }
  }
  if (!args.live) {
    return;
  }
  for (const client of clients) {
    // oxlint-disable-next-line no-await-in-loop -- one client at a time
    const secret = await routerSecretOf(client);
    // oxlint-disable-next-line no-await-in-loop -- as above
    const answer = await dispatch(
      clientName({ prefix, client }, "core"),
      "/health",
      { headers: { [routerSecretHeader]: secret } }
    );
    // oxlint-disable-next-line no-await-in-loop -- as above
    const body = await jsonOf(answer);
    check(
      `${client}: core answers its health check`,
      answer.ok ? "pass" : "fail",
      {
        status: answer.status,
        body,
      }
    );
  }
};

const probeName = (client: Client): string =>
  clientName({ prefix, client }, "probe");
const recorderName = `${prefix}-effects`;

const uploadRecorder = async (): Promise<void> => {
  await uploadScript(
    userPath(recorderName),
    {
      main_module: "recorder.js",
      compatibility_date: probeCompatibilityDate,
      bindings: [
        {
          type: "durable_object_namespace",
          name: "EFFECTS_OBJECT",
          class_name: "Effects",
        },
      ],
      migrations: { new_tag: "v1", new_sqlite_classes: ["Effects"] },
    },
    { "recorder.js": recorderSource }
  );
};

const probesStep = async (): Promise<void> => {
  const uploaded = await orPlanned(async () => {
    await uploadRecorder();
    for (const client of clients) {
      // oxlint-disable-next-line no-await-in-loop -- one client at a time
      await uploadScript(
        userPath(probeName(client)),
        {
          main_module: "probe.js",
          compatibility_date: probeCompatibilityDate,
          bindings: [
            {
              type: "durable_object_namespace",
              name: "PROBE_OBJECT",
              class_name: "ProbeObject",
            },
            { type: "worker_loader", name: "LOADER" },
            { type: "service", name: "PEER", service: recorderName },
          ],
          migrations: { new_tag: "v1", new_sqlite_classes: ["ProbeObject"] },
        },
        { "probe.js": probeSource }
      );
    }
  });
  if (uploaded === "planned") {
    check("probes uploaded", "skipped");
    return;
  }
  check(
    "probes uploaded with a Durable Object, the Loader and a service binding",
    "pass"
  );
  for (const client of clients) {
    const probe = probeName(client);
    // oxlint-disable-next-line no-await-in-loop -- in turn
    const object = await jsonOf(await dispatch(probe, "/object"));
    const placed = z
      .object({ jurisdiction: z.string().nullable(), sql: z.number() })
      .safeParse(object);
    check(
      `${client}: a SQLite Durable Object made in the EU jurisdiction`,
      placed.success &&
        placed.data.jurisdiction === "eu" &&
        placed.data.sql === 1
        ? "pass"
        : "fail",
      { answer: object }
    );
    // oxlint-disable-next-line no-await-in-loop -- in turn
    const loaderAnswer = await dispatch(
      probe,
      "/loader?target=https%3A%2F%2Fexample.com%2F"
    );
    // oxlint-disable-next-line no-await-in-loop -- in turn
    const loader = await jsonOf(loaderAnswer);
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
    // oxlint-disable-next-line no-await-in-loop -- in turn
    const peer = await jsonOf(await dispatch(probe, "/peer"));
    check(
      `${client}: a service binding reaches another user Worker in the namespace`,
      z.object({ status: z.literal(200) }).safeParse(peer).success
        ? "pass"
        : "fail",
      { answer: peer }
    );
  }
};

const durableName = `${prefix}-durable`;

/** Workerflow's death fixture, bundled as a deploy would (its own harness's way). */
const bundledFixture = (): string => {
  const dir = path.join(outDir, "fixture");
  mkdirSync(dir, { recursive: true });
  const bundled = wrangler(
    [
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
    path.resolve("packages/workerflow")
  );
  if (!bundled.ok) {
    throw new Error(
      `Bundling the death fixture failed: ${tail(bundled.output)}`
    );
  }
  const module = readdirSync(dir).find((file) => file.endsWith(".js"));
  if (module === undefined) {
    throw new Error("Wrangler wrote no module for the death fixture");
  }
  return readFileSync(path.join(dir, module), "utf-8");
};

const uploadFixture = async (source: string): Promise<void> => {
  await uploadScript(
    userPath(durableName),
    {
      main_module: "fixture.js",
      compatibility_date: probeCompatibilityDate,
      compatibility_flags: ["nodejs_als"],
      bindings: [
        { type: "durable_object_namespace", name: "RUNS", class_name: "Runs" },
        { type: "service", name: "EFFECTS", service: recorderName },
      ],
      migrations: { new_tag: "v1", new_sqlite_classes: ["Runs"] },
    },
    { "fixture.js": source }
  );
};

const effectRows = z.array(
  z.object({ run: z.string(), label: z.string(), key: z.string() }).loose()
);

const effectsOf = async (id: string) =>
  effectRows.parse(
    await jsonOf(
      await dispatch(recorderName, `/list?run=${encodeURIComponent(id)}`)
    )
  );

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
        .safeParse(
          await jsonOf(
            await dispatch(durableName, `/status?definition=napper&id=${id}`)
          )
        );
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
  const status = await jsonOf(
    await dispatch(durableName, `/status?definition=napper&id=${id}`)
  );
  check(
    `durability (${how}): finished, each completed effect once`,
    count("before") === 1 && count("after") === 1 ? "pass" : "fail",
    { effects, status }
  );
};

const durabilityStep = async (): Promise<void> => {
  const source = bundledFixture();
  const uploaded = await orPlanned(async () => {
    await uploadRecorder();
    await uploadFixture(source);
  });
  if (uploaded === "planned") {
    check("durability fixture uploaded", "skipped");
    return;
  }
  check("durability fixture uploaded as a user Worker", "pass");
  // A new version of the script: workerd restarts its objects.
  await killAndResume("new-version", async () => {
    await uploadFixture(source);
  });
  // The run object reset from inside (`ctx.abort`), as an eviction is.
  await killAndResume("evicted", async (id) => {
    await dispatch(durableName, `/evict?definition=napper&id=${id}`);
  });
};

const settingsSchema = z
  .object({
    bindings: z.array(z.object({ type: z.string(), name: z.string() }).loose()),
  })
  .loose();

const attackStep = async (): Promise<void> => {
  if (!args.live) {
    check("attacks", "skipped");
    return;
  }
  const secretA = await routerSecretOf("a");
  const secretB = await routerSecretOf("b");
  const coreB = clientName({ prefix, client: "b" }, "core");
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
    {
      status: withB,
    }
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
  // Every binding of each client's scripts names only its own.
  for (const client of clients) {
    const other = clients.find((name) => name !== client) ?? client;
    const otherPrefix = `${prefix}-${other}-`;
    for (const app of [...releaseApps, "probe"]) {
      const script = clientName({ prefix, client }, app);
      // oxlint-disable-next-line no-await-in-loop -- in turn
      const settings = await api
        .call(
          { method: "GET", path: `${userPath(script)}/settings` },
          settingsSchema
        )
        .catch((error: unknown) => ({ error: errorText(error) }));
      const namesOther =
        "error" in settings || JSON.stringify(settings).includes(otherPrefix);
      check(
        `${client}: ${app}'s bindings name nothing of ${other}`,
        namesOther ? "fail" : "pass",
        { settings }
      );
    }
  }
  const objects = await api.call(
    {
      method: "GET",
      path: "/workers/durable_objects/namespaces?per_page=1000",
    },
    z.array(
      z
        .object({
          id: z.string(),
          script: z.string().optional(),
          class: z.string().optional(),
        })
        .loose()
    )
  );
  const ofClient = (client: Client) =>
    objects.filter(
      ({ script }) => script?.startsWith(`${prefix}-${client}-`) === true
    );
  const shared = ofClient("a").filter(({ id }) =>
    ofClient("b").some((object) => object.id === id)
  );
  check(
    "a's and b's Durable Object namespaces are their own",
    ofClient("a").length > 0 && shared.length === 0 ? "pass" : "fail",
    { a: ofClient("a"), b: ofClient("b") }
  );
};

const emailStep = async (): Promise<void> => {
  const name = `${prefix}-mail`;
  const to = process.env.QUAL_MAIL_TO;
  const uploaded = await orPlanned(async () => {
    try {
      await uploadScript(
        userPath(name),
        {
          main_module: "mail.js",
          compatibility_date: probeCompatibilityDate,
          bindings: [
            {
              type: "send_email",
              name: "EMAIL",
              ...(to === undefined ? {} : { destination_address: to }),
            },
          ],
        },
        { "mail.js": mailSource }
      );
      return true;
    } catch (error) {
      if (error instanceof CloudflareError) {
        check("a user Worker may have a send_email binding", "fail", {
          error: errorText(error),
          codes: error.codes,
        });
        return false;
      }
      throw error;
    }
  });
  if (uploaded === "planned") {
    check("a user Worker may have a send_email binding", "skipped");
    return;
  }
  if (!uploaded) {
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
    const answer = await send(foreign);
    check("send_email from a domain outside the account", "observed", {
      answer,
    });
  }
};

const cleanupStep = async (): Promise<void> => {
  if (!args.live) {
    check("cleanup", "skipped");
    return;
  }
  const found = await inventory();
  const ours = (names: readonly string[]) =>
    names.filter((name) => name.startsWith(prefix));
  const scripts = await api
    .call(
      { method: "GET", path: `/workers/dispatch/namespaces/${prefix}/scripts` },
      z.array(z.object({ id: z.string() }).loose())
    )
    .catch(() => []);
  for (const { id } of scripts) {
    // oxlint-disable-next-line no-await-in-loop -- in turn
    await api.call(
      { method: "DELETE", path: `${userPath(id)}?force=true` },
      z.unknown()
    );
  }
  for (const name of ours(found.namespaces)) {
    // oxlint-disable-next-line no-await-in-loop -- in turn
    await api.call(
      { method: "DELETE", path: `/workers/dispatch/namespaces/${name}` },
      z.unknown()
    );
  }
  for (const name of ours(found.scripts)) {
    // oxlint-disable-next-line no-await-in-loop -- in turn
    await api.call(
      { method: "DELETE", path: `/workers/scripts/${name}?force=true` },
      z.unknown()
    );
  }
  const databases = await api.call(
    { method: "GET", path: "/d1/database?per_page=10000" },
    z.array(z.object({ name: z.string(), uuid: z.string() }).loose())
  );
  for (const { name, uuid } of databases.filter((database) =>
    database.name.startsWith(prefix)
  )) {
    own(uuid);
    // oxlint-disable-next-line no-await-in-loop -- in turn
    await api.call(
      { method: "DELETE", path: `/d1/database/${uuid}` },
      z.unknown()
    );
    record({ kind: "deleted", what: "d1", name });
  }
  for (const name of ours(found.euBuckets)) {
    // oxlint-disable-next-line no-await-in-loop -- in turn
    await api.call(
      {
        method: "DELETE",
        path: `/r2/buckets/${name}`,
        headers: { "cf-r2-jurisdiction": "eu" },
      },
      z.unknown()
    );
  }
  const after = await recordInventory("after cleanup");
  const left = inventoryKinds
    .flatMap((kind) => after[kind])
    .filter((name) => name.startsWith(prefix));
  check("nothing of the run is left", left.length === 0 ? "pass" : "fail", {
    left,
  });
};

const run: Record<Step, () => Promise<void>> = {
  preflight,
  namespace: namespaceStep,
  dispatcher: dispatcherStep,
  release: releaseStep,
  probes: probesStep,
  durability: durabilityStep,
  attack: attackStep,
  email: emailStep,
  inventory: async () => {
    await recordInventory("after");
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
