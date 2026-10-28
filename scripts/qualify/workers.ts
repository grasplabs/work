/**
 * What the real-account qualification (run.ts) uploads besides the
 * release: small Workers whose every line is here, so what they prove is
 * plain, and the rewrite of a release Worker's wrangler.json for one test
 * client in the run's dispatch namespace. Every Worker is uploaded by
 * `cf deploy --prebuilt` from Build Output this module writes (`writeBuildOutput`):
 * the modules as they are, unbundled, so the account runs exactly them.
 */

import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The compatibility date the probes run at: core's. */
export const probeCompatibilityDate = "2026-09-15";

/** The header the dispatcher takes its target script from. */
export const targetHeader = "x-qual-script";
/** The header that carries the run's dispatch key: without it, nothing passes. */
export const dispatchKeyHeader = "x-qual-key";

/**
 * The run's dispatcher, an ordinary Worker on workers.dev: the only way
 * into the namespace. It passes a request on to the user Worker its
 * `x-qual-script` names (or to the durability check's outside world, an
 * account Worker), only one of the run's and only with the run's dispatch
 * key, which it strips first.
 */
export const dispatcherSource = (prefix: string): string => `
const prefix = ${JSON.stringify(prefix)};
export default {
  async fetch(request, env) {
    const target = request.headers.get(${JSON.stringify(targetHeader)}) ?? "";
    const key = request.headers.get(${JSON.stringify(dispatchKeyHeader)}) ?? "";
    if (key === "" || key !== env.DISPATCH_KEY || !target.startsWith(prefix + "-")) {
      return new Response("unknown", { status: 404 });
    }
    const headers = new Headers(request.headers);
    headers.delete(${JSON.stringify(targetHeader)});
    headers.delete(${JSON.stringify(dispatchKeyHeader)});
    try {
      // The durability check's outside world is an account Worker of its own.
      const to = target === prefix + "-outside" ? env.OUTSIDE : env.DISPATCHER.get(target);
      return await to.fetch(new Request(request, { headers }));
    } catch (error) {
      return new Response(String(error?.message ?? error), { status: 502 });
    }
  },
};
`;

/**
 * The outside world of the durability check: what the death fixture's
 * steps tell it (packages/workerflow/test/death-fixture.ts, the same
 * protocol as its plain-workerd harness), kept in a SQLite Durable Object
 * so a kill of the fixture can't lose it. `GET /list?run=` reads them back.
 */
export const recorderSource = `
import { DurableObject } from "cloudflare:workers";
export class Effects extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS effects (n INTEGER PRIMARY KEY, run TEXT, label TEXT, key TEXT, attempt INTEGER, at INTEGER)");
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/list") {
      const rows = this.ctx.storage.sql
        .exec("SELECT run, label, key, attempt, at FROM effects WHERE run = ? ORDER BY n", url.searchParams.get("run") ?? "")
        .toArray();
      return Response.json(rows);
    }
    if (url.pathname !== "/effect") {
      return new Response("{}");
    }
    const sent = await request.json();
    this.ctx.storage.sql.exec(
      "INSERT INTO effects (run, label, key, attempt, at) VALUES (?, ?, ?, ?, ?)",
      sent.run, sent.label, sent.key, sent.attempt, Date.now()
    );
    const count = this.ctx.storage.sql.exec("SELECT count(*) AS n FROM effects").one().n;
    return new Response(sent.label + "#" + count);
  }
}
export default {
  fetch: (request, env) => env.EFFECTS_OBJECT.get(env.EFFECTS_OBJECT.idFromName("effects")).fetch(request),
};
`;

/**
 * A test client's probe, a user Worker with the binding kinds core and
 * connect need from a dispatch namespace:
 * - \`/object\`: a SQLite Durable Object made in the EU jurisdiction, which
 *   answers where its id says it is and that SQL runs;
 * - \`/loader\`: a Worker Loader isolate with core's sandbox options (no
 *   network, empty env), which tries the network and the Cache API;
 * - \`/peer\`: a service binding to another user Worker in the namespace,
 *   or a binding to the namespace itself where the first is refused;
 * - \`POST /reach\`: a fetch from inside the namespace to \`{ url, headers }\`,
 *   for the attacks: what one client's code gets from another's.
 */
export const probeSource = `
import { DurableObject } from "cloudflare:workers";
export class ProbeObject extends DurableObject {
  async fetch() {
    const row = this.ctx.storage.sql.exec("SELECT 1 AS one").one();
    return Response.json({ jurisdiction: this.ctx.id.jurisdiction ?? null, sql: row.one });
  }
}
const isolate = \`
export default {
  async fetch(request, env) {
    const target = new URL(request.url).searchParams.get("target");
    const tried = {};
    try { tried.fetch = (await fetch(target)).status; } catch (error) { tried.fetch = String(error?.message ?? error); }
    try { await caches.default.put("https://qual.invalid/k", new Response("v")); tried.cache = "put"; } catch (error) { tried.cache = String(error?.message ?? error); }
    tried.env = Object.keys(env ?? {}).length;
    return Response.json(tried);
  },
};
\`;
const errorText = (error) => String(error?.message ?? error);
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/object") {
        const id = env.PROBE_OBJECT.jurisdiction("eu").idFromName("probe");
        return await env.PROBE_OBJECT.get(id).fetch("http://object/");
      }
      if (url.pathname === "/loader") {
        const stub = env.LOADER.load({
          compatibilityDate: ${JSON.stringify(probeCompatibilityDate)},
          mainModule: "isolate.js",
          modules: { "isolate.js": isolate },
          globalOutbound: null,
          env: {},
          limits: { cpuMs: 10000 },
        });
        const target = url.searchParams.get("target") ?? "https://example.com/";
        return await stub.getEntrypoint().fetch("http://isolate/?target=" + encodeURIComponent(target));
      }
      if (url.pathname === "/peer") {
        // A service binding to the other user Worker, or, where the
        // namespace refuses that, a binding to the namespace itself.
        const peer = env.PEER ?? env.PEERS.get(env.PEER_NAME);
        const answer = await peer.fetch("http://peer/list?run=probe");
        return Response.json({ status: answer.status, through: env.PEER === undefined ? "dispatch-namespace" : "service" });
      }
      if (url.pathname === "/gateway") {
        // Through the gateway's fetch, then through the stub its RPC hands
        // back, then asking it for another client's connect by name.
        const tried = async (work) => {
          try {
            return await work();
          } catch (error) {
            return "error: " + String(error?.message ?? error);
          }
        };
        const other = url.searchParams.get("other") ?? "";
        return Response.json({
          fetched: await tried(async () => await (await env.CONNECT.fetch("http://connect/name")).text()),
          rpc: await tried(async () => await env.CONNECT.name()),
          asked: await tried(async () => await env.CONNECT.name(other)),
          // A method named as one of the gateway's own would be, were it to have any.
          call: await tried(async () => await env.CONNECT.call(other)),
          stream: await tried(async () => await new Response(await env.CONNECT.bytes()).text()),
        });
      }
      if (url.pathname === "/reach" && request.method === "POST") {
        const { url: target, headers } = await request.json();
        const answer = await fetch(target, { headers, redirect: "manual" });
        return Response.json({ status: answer.status });
      }
      return new Response("unknown", { status: 404 });
    } catch (error) {
      return Response.json({ error: errorText(error) }, { status: 500 });
    }
  },
};
`;

/**
 * The send_email spike (GRA-965): a user Worker with a \`send_email\`
 * binding, which sends one plain message \`POST /send { from, to }\` asks
 * for, and answers what the binding did.
 */
export const mailSource = `
import { EmailMessage } from "cloudflare:email";
export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("unknown", { status: 404 });
    }
    const { from, to } = await request.json();
    const raw = [
      "From: " + from,
      "To: " + to,
      "Subject: Grasp OS qualification (GRA-965)",
      "Message-ID: <" + crypto.randomUUID() + "@" + from.split("@")[1] + ">",
      "Date: " + new Date().toUTCString(),
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Sent by a Workers for Platforms user Worker in a qualification run.",
    ].join("\\r\\n");
    try {
      await env.EMAIL.send(new EmailMessage(from, to, raw));
      return Response.json({ sent: true });
    } catch (error) {
      return Response.json({ sent: false, error: String(error?.message ?? error) });
    }
  },
};
`;

/** A Worker of a release's wrangler.json, as deploy-lib.ts writes it. */
export type ReleaseConfig = Record<string, unknown> & { name: string };

/** The binding kinds the release's Workers have, by their wrangler.json key. */
export const bindingKeys = [
  "durable_objects",
  "workflows",
  "worker_loaders",
  "d1_databases",
  "r2_buckets",
  "send_email",
  "services",
  "ai",
  "version_metadata",
] as const;
export type BindingKey = (typeof bindingKeys)[number];

/** What a client's copy of a release Worker is given. */
export interface ClientWorker {
  prefix: string;
  /** `a` or `b`. */
  client: string;
  /** Each release Worker's name (`grasp-os-connect`) to its app (`connect`). */
  apps: Readonly<Record<string, string>>;
  /** Each database the release names, to the id the run created for this client. */
  databaseIds: Readonly<Record<string, string>>;
  /** Binding kinds left out of this attempt. */
  without: ReadonlySet<BindingKey>;
  /**
   * The connect gateway's script, when the run has one: each service
   * binding then binds it, its props naming the client's own script, as
   * the admin renders a placed core's (GRA-1217).
   */
  gateway?: string;
}

/** A client's probe or stand-in name: `<prefix>-<client>-<name>`. */
export const clientName = (
  { prefix, client }: Pick<ClientWorker, "prefix" | "client">,
  name: string
): string => `${prefix}-${client}-${name}`;

/** The run's prefix as a placed client's deployment id carries it: its letters and digits. */
export const compactPrefix = (prefix: string): string =>
  prefix.replaceAll(/[^a-z0-9]/gu, "");

/**
 * A test client's release resource or script, named as the admin names a
 * placed client's (`g<deployment>-<logical name>`, apps/admin's
 * hosting/inventory.ts): the deployment id is the run's prefix, compacted,
 * then the client. So the connect gateway, which serves only scripts
 * named as a client connect's, serves the run's.
 */
export const clientResourceName = (
  { prefix, client }: Pick<ClientWorker, "prefix" | "client">,
  logicalName: string
): string => `g${compactPrefix(prefix)}${client}-${logicalName}`;

const listOf = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null
      )
    : [];

const textOf = (entry: Record<string, unknown>, key: string): string => {
  const value = entry[key];
  if (typeof value !== "string") {
    throw new TypeError(`A binding has no ${key}`);
  }
  return value;
};

/**
 * `config` (a release Worker's wrangler.json) as one test client's user
 * Worker: named after the client, its databases and buckets the client's
 * own (`<prefix>-<client>-…`, the databases by the ids the run created),
 * its services the client's own copy of the other release Worker, no
 * workers.dev, no previews and no cron triggers (which Workers for
 * Platforms doesn't document for user Workers), and the binding kinds in
 * `without` left out. Nothing of the other client is named.
 */
export const clientConfig = (
  config: ReleaseConfig,
  worker: ClientWorker
): ReleaseConfig => {
  const rename = (name: string) => clientResourceName(worker, name);
  const rewritten: ReleaseConfig = {
    ...config,
    name: rename(config.name),
    workers_dev: false,
    preview_urls: false,
    triggers: { crons: [] },
    d1_databases: listOf(config.d1_databases).map((database) => {
      const name = textOf(database, "database_name");
      const id = worker.databaseIds[name];
      if (id === undefined) {
        throw new Error(`No database was created for ${name}`);
      }
      return { ...database, database_name: rename(name), database_id: id };
    }),
    r2_buckets: listOf(config.r2_buckets).map((bucket) => ({
      ...bucket,
      bucket_name: rename(textOf(bucket, "bucket_name")),
    })),
    services: listOf(config.services).map((service) => {
      const app = worker.apps[textOf(service, "service")];
      if (app === undefined) {
        throw new Error(
          `${config.name} binds ${textOf(service, "service")}, which isn't a Worker of the release`
        );
      }
      const script = rename(textOf(service, "service"));
      return worker.gateway === undefined
        ? { ...service, service: script }
        : {
            binding: textOf(service, "binding"),
            service: worker.gateway,
            props: { script },
          };
    }),
  };
  const dropped: ReadonlySet<string> = worker.without;
  return {
    ...Object.fromEntries(
      Object.entries(rewritten).filter(([key]) => !dropped.has(key))
    ),
    name: rewritten.name,
  };
};

/**
 * The databases and buckets a release Worker's wrangler.json names: what
 * the run creates for each client before it uploads it.
 */
export const storageOf = (
  config: ReleaseConfig
): { databases: string[]; buckets: string[] } => ({
  databases: listOf(config.d1_databases).map((database) =>
    textOf(database, "database_name")
  ),
  buckets: listOf(config.r2_buckets).map((bucket) =>
    textOf(bucket, "bucket_name")
  ),
});

/** A binding in Build Output's `worker.config.json`, as cf reads it. */
export type OutputBinding = Record<string, unknown> & { type: string };

/**
 * A binding to a Durable Object class of the Worker itself. cf's typed
 * binding (`durable-object`) names the Worker as the class's script, and
 * in a dispatch namespace the API refuses that: no account script has the
 * user Worker's name (10061, seen on the GRA-430 run). So it goes as the
 * API's own binding, which names no script and means the Worker's own
 * class, passed through as cf's `unsafe:` binding.
 */
export const ownObject = (className: string): OutputBinding => ({
  type: "unsafe:durable_object_namespace",
  class_name: className,
});

/** A Worker as Build Output describes it (cf's Build Output Specification, v0). */
export interface OutputWorker {
  name: string;
  compatibilityDate: string;
  compatibilityFlags?: string[];
  workersDev?: boolean;
  previewUrls?: boolean;
  env?: Record<string, OutputBinding>;
  exports?: Record<
    string,
    { type: "durable-object"; storage: "sqlite" | "legacy-kv" }
  >;
  assets?: Record<string, unknown>;
  manifest: {
    type: "complete";
    mainModule: string;
    modules: Record<string, { type: string }>;
  };
}

/** One module of a Worker: its name, its type and its bytes. */
export interface OutputModule {
  name: string;
  type: string;
  content: string | Uint8Array;
}

/**
 * Writes `worker` as Build Output under `projectDir`
 * (`.cloudflare/output/v0/`), with its modules and, from `assetsFrom`, its
 * static files: what `cf deploy --prebuilt` uploads, with no build.
 */
export const writeBuildOutput = (
  projectDir: string,
  worker: Omit<OutputWorker, "manifest">,
  mainModule: string,
  modules: readonly OutputModule[],
  assetsFrom?: string
): void => {
  const root = path.join(projectDir, ".cloudflare", "output", "v0");
  const own = path.join(root, "workers", "default");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(path.join(own, "bundle"), { recursive: true });
  writeFileSync(
    path.join(root, "config.json"),
    JSON.stringify({ buildContext: { isPreview: false } })
  );
  for (const { name, content } of modules) {
    const file = path.join(own, "bundle", name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  if (assetsFrom !== undefined) {
    cpSync(assetsFrom, path.join(own, "assets"), { recursive: true });
  }
  const full: OutputWorker = {
    ...worker,
    manifest: {
      type: "complete",
      mainModule,
      modules: Object.fromEntries(
        modules.map(({ name, type }) => [name, { type }])
      ),
    },
  };
  writeFileSync(path.join(own, "worker.config.json"), JSON.stringify(full));
};

/** A Durable Object migration, as a release's wrangler.json lists them. */
interface Migration {
  new_sqlite_classes?: string[];
  new_classes?: string[];
  renamed_classes?: { from: string; to: string }[];
  deleted_classes?: string[];
}

/**
 * The Durable Object classes `migrations` leave live, with their storage:
 * what Build Output declares as exports. A fresh upload has no history to
 * replay, so only the classes live at the end are declared.
 */
export const liveClasses = (
  migrations: readonly Migration[]
): Record<string, "sqlite" | "legacy-kv"> => {
  const live = new Map<string, "sqlite" | "legacy-kv">();
  for (const migration of migrations) {
    for (const name of migration.new_sqlite_classes ?? []) {
      live.set(name, "sqlite");
    }
    for (const name of migration.new_classes ?? []) {
      live.set(name, "legacy-kv");
    }
    for (const { from, to } of migration.renamed_classes ?? []) {
      const storage = live.get(from);
      live.delete(from);
      if (storage !== undefined) {
        live.set(to, storage);
      }
    }
    for (const name of migration.deleted_classes ?? []) {
      live.delete(name);
    }
  }
  return Object.fromEntries(live);
};

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

const migrationsOf = (value: unknown): Migration[] =>
  listOf(value).map((entry) => ({
    new_sqlite_classes: stringsOf(entry.new_sqlite_classes),
    new_classes: stringsOf(entry.new_classes),
    deleted_classes: stringsOf(entry.deleted_classes),
    renamed_classes: listOf(entry.renamed_classes).map((renamed) => ({
      from: textOf(renamed, "from"),
      to: textOf(renamed, "to"),
    })),
  }));

/** A release's assets settings (wrangler.json's), as Build Output names them. */
const assetSettings: Readonly<Record<string, string>> = {
  html_handling: "htmlHandling",
  not_found_handling: "notFoundHandling",
  run_worker_first: "runWorkerFirst",
};

/**
 * A client's release Worker (`clientConfig`'s wrangler.json) as Build
 * Output describes it, but for its manifest: each binding by the kind cf
 * names it, its vars as text or JSON, its Durable Object classes as
 * exports. Workflows are left out: a placed client binds none.
 */
export const outputOf = (
  config: ReleaseConfig
): Omit<OutputWorker, "manifest"> => {
  const env: Record<string, OutputBinding> = {};
  for (const binding of listOf(recordOf(config.durable_objects).bindings)) {
    env[textOf(binding, "name")] = ownObject(textOf(binding, "class_name"));
  }
  for (const loader of listOf(config.worker_loaders)) {
    env[textOf(loader, "binding")] = { type: "worker-loader" };
  }
  for (const database of listOf(config.d1_databases)) {
    env[textOf(database, "binding")] = {
      type: "d1",
      id: textOf(database, "database_id"),
    };
  }
  for (const bucket of listOf(config.r2_buckets)) {
    env[textOf(bucket, "binding")] = {
      type: "r2",
      name: textOf(bucket, "bucket_name"),
      jurisdiction: textOf(bucket, "jurisdiction"),
    };
  }
  for (const service of listOf(config.services)) {
    const { entrypoint, props } = service;
    env[textOf(service, "binding")] = {
      type: "worker",
      worker: textOf(service, "service"),
      ...(typeof entrypoint === "string" ? { exportName: entrypoint } : {}),
      ...(typeof props === "object" && props !== null ? { props } : {}),
    };
  }
  for (const mail of listOf(config.send_email)) {
    env[textOf(mail, "name")] = { type: "send-email" };
  }
  const ai = recordOf(config.ai);
  if (typeof ai.binding === "string") {
    env[ai.binding] = { type: "ai" };
  }
  const metadata = recordOf(config.version_metadata);
  if (typeof metadata.binding === "string") {
    env[metadata.binding] = { type: "version-metadata" };
  }
  for (const [name, value] of Object.entries(recordOf(config.vars))) {
    env[name] =
      typeof value === "string"
        ? { type: "text", value }
        : { type: "json", value };
  }
  const assets = recordOf(config.assets);
  if (typeof assets.binding === "string") {
    env[assets.binding] = { type: "assets" };
  }
  const settings = Object.fromEntries(
    Object.entries(assets).flatMap(([key, value]) => {
      const name = assetSettings[key];
      return name === undefined ? [] : [[name, value]];
    })
  );
  const classes = liveClasses(migrationsOf(config.migrations));
  return {
    name: config.name,
    compatibilityDate: textOf(config, "compatibility_date"),
    compatibilityFlags: stringsOf(config.compatibility_flags),
    workersDev: false,
    previewUrls: false,
    env,
    exports: Object.fromEntries(
      Object.entries(classes).map(([name, storage]) => [
        name,
        { type: "durable-object" as const, storage },
      ])
    ),
    ...(Object.keys(settings).length === 0 ? {} : { assets: settings }),
  };
};

/**
 * The connect gateway (the candidate for core's binding to its own
 * connect, GRA-430): an ordinary account Worker every client's core binds
 * by a service binding whose props the admin sets as it uploads core,
 * naming that client's connect. It reaches the namespace itself, and only
 * ever the script its binding's props name: never one its caller names.
 */
export const gatewaySource = `
import { WorkerEntrypoint } from "cloudflare:workers";
// Every method its caller calls, fetch included, is the client's
// connect's, called on the script the binding's props name, whatever the
// caller passes: the gateway has no method of its own.
export default class Gateway extends WorkerEntrypoint {
  constructor(ctx, env) {
    super(ctx, env);
    const client = () => env.CLIENTS.get(ctx.props.script);
    return new Proxy(this, {
      get: (target, key, receiver) =>
        typeof key !== "string" || key === "constructor"
          ? Reflect.get(target, key, receiver)
          : (...args) => client()[key](...args),
    });
  }
  // Declared for the upload, which wants a handler; the proxy answers it.
  fetch() {
    return new Response(null, { status: 500 });
  }
}
`;

/** A stand-in for one client's connect: it answers its own name, over fetch and RPC. */
export const connectStandInSource = (name: string): string => `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class Connect extends WorkerEntrypoint {
  name() {
    return ${JSON.stringify(name)};
  }
  call() {
    return ${JSON.stringify(name)};
  }
  // A stream, as a file read through connect is.
  bytes() {
    return new Blob([${JSON.stringify(name)}]).stream();
  }
  fetch() {
    return new Response(${JSON.stringify(name)});
  }
}
`;
