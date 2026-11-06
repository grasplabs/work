/**
 * The Cloudflare calls a placed client's deploy makes: uploading its
 * scripts (with their static assets), their secrets, cron schedules and
 * workers.dev route, reading what is live, and applying D1 migrations.
 */
import { sha256Hex } from "@grasp-os/shared/encoding";
import { log } from "@grasp-os/shared/log";
import { mapConcurrently } from "@grasp-os/shared/release";
import { z } from "zod";

import { CloudflareApiError, isNotFound } from "./api.ts";
import type { ApiCall, CloudflareApi } from "./api.ts";
import { D1MigrationError } from "./d1-migration-error.ts";

/*
 * A release's files are read as its upload sends them, never all at once:
 * core's are over 100 MB (its modules, and its static files as the
 * base64 the assets upload takes), and a Worker, a Workflow step's run
 * included, is stopped past 128 MB of memory, which its isolate may share
 * with other requests. So a static file is read only when the account
 * lacks it, one file per request, and the modules stream into the
 * script's upload one after another: it holds a chunk at a time, whatever
 * the release's size. FormData can't do that (its files are Blobs, held
 * whole, and workerd builds the whole body again to send it), so the
 * uploads' forms are written as the HTML standard encodes
 * multipart/form-data, their length known up front (`FixedLengthStream`),
 * as a form's is.
 */

/** One module of a Worker, as its bundle holds it. */
export interface WorkerModule {
  /** Its path in the bundle, such as `index.js`. */
  name: string;
  /** Such as `application/javascript+module`, `text/plain` or `application/wasm`. */
  type: string;
  /** Its size in bytes. */
  size: number;
  /** Its `size` bytes, streamed as the upload sends them. */
  stream: () => Promise<ReadableStream<Uint8Array>>;
}

/**
 * The upload's `metadata` part as the API takes it (`main_module`,
 * `compatibility_date`, `bindings`, `migrations`, `assets.config`, ...),
 * built from the release's wrangler config.
 */
export type WorkerMetadata = Record<string, unknown> & {
  main_module: string;
  assets?: Record<string, unknown>;
};

/** A static file the Worker serves through its assets binding. */
export interface AssetFile {
  /** Its URL path, such as `/index.html`. */
  path: string;
  /** Its content key (`encodeAsset`), as the release manifest names it. */
  key: string;
  /** Its size in bytes. */
  size: number;
  /** Its content type, such as `text/html`. */
  type: string;
  /**
   * Its contents as base64 (`encodeAsset`), checked against `key`: read
   * only when the account lacks the file.
   */
  readBase64: () => Promise<Uint8Array<ArrayBuffer>>;
}

/** What one Worker of a release is uploaded as. */
export interface WorkerUpload {
  /** The release it comes from: the version's `workers/tag`. */
  releaseId: string;
  metadata: WorkerMetadata;
  modules: readonly WorkerModule[];
  /**
   * The token its static files went up under (`uploadTargetAssets`), if
   * it serves any.
   */
  assetsJwt?: string;
}

const uploadSessionSchema = z.object({
  jwt: z.string(),
  /** The hashes it lacks, in groups to upload together. */
  buckets: z.array(z.array(z.string())).nullish(),
});
const uploadedSchema = z.object({ jwt: z.string().nullish() }).nullish();

/** Where a placed client's script is: a dispatch namespace in an account. */
export interface ScriptTarget {
  accountId: string;
  scriptName: string;
  /** The Workers for Platforms dispatch namespace. */
  namespace: string;
}

/** The API path of the script `target` names. */
const targetPath = ({ accountId, scriptName, namespace }: ScriptTarget) =>
  `/accounts/${accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}`;

/**
 * The key a file goes up under: its content key (`encodeAsset`) and its
 * type, hashed together, cut to the 32 hex characters the API takes.
 */
const typedAssetKey = async (key: string, type: string): Promise<string> => {
  const hash = await sha256Hex(`${key}\n${type}`);
  return hash.slice(0, 32);
};

/** One file of an upload's form: `size` bytes of `type`, read as it goes out. */
interface FormPart {
  name: string;
  type: string;
  size: number;
  read: () => Promise<ReadableStream<Uint8Array> | Uint8Array>;
}

const encoder = new TextEncoder();
const lineBreak = encoder.encode("\r\n");

/** `name` quoted in a part's header, escaped as the HTML standard does. */
const quoted = (name: string): string =>
  `"${name.replaceAll("\n", "%0A").replaceAll("\r", "%0D").replaceAll('"', "%22")}"`;

/**
 * Writes `part`'s contents to `writer` as they're read. A part that can't
 * be read aborts `failed` with why, so the call stops with it rather than
 * being retried as if its answer were lost; a write that fails, because
 * the request ended, doesn't.
 */
const writePart = async (
  writer: WritableStreamDefaultWriter<Uint8Array>,
  part: FormPart,
  failed: AbortController
): Promise<void> => {
  let contents: ReadableStream<Uint8Array> | Uint8Array;
  try {
    contents = await part.read();
  } catch (error) {
    failed.abort(error);
    throw error;
  }
  if (contents instanceof Uint8Array) {
    await writer.write(contents);
    return;
  }
  await contents.pipeTo(
    new WritableStream({
      write: async (chunk) => {
        await writer.write(chunk);
      },
      // Called when the part's stream errors, not when a write fails.
      abort: (reason) => {
        failed.abort(reason);
      },
    })
  );
};

/**
 * `parts` as a multipart form, each read as the request sends it. Not
 * form-data-encoder (4.1.0): it splits a chunk over 64 KiB from the start
 * of its whole buffer, ignoring `byteOffset`, so it would send a stream's
 * view into a larger buffer as other bytes, silently and after our check.
 * `sent` is called once its last byte has gone out.
 */
const formBody = (
  boundary: string,
  parts: readonly FormPart[],
  failed: AbortController,
  sent?: () => void
): ReadableStream<Uint8Array> => {
  const headed = parts.map((part) => ({
    part,
    head: encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name=${quoted(part.name)}; filename=${quoted(part.name)}\r\nContent-Type: ${part.type}\r\n\r\n`
    ),
  }));
  const tail = encoder.encode(`--${boundary}--\r\n`);
  const { readable, writable } = new FixedLengthStream(
    headed.reduce(
      (length, { part, head }) =>
        length + head.byteLength + part.size + lineBreak.byteLength,
      tail.byteLength
    )
  );
  const writer = writable.getWriter();
  const write = async (): Promise<void> => {
    try {
      for (const { part, head } of headed) {
        // oxlint-disable-next-line no-await-in-loop -- one part at a time, in order
        await writer.write(head);
        // oxlint-disable-next-line no-await-in-loop -- one part at a time, in order
        await writePart(writer, part, failed);
        // oxlint-disable-next-line no-await-in-loop -- one part at a time, in order
        await writer.write(lineBreak);
      }
      await writer.write(tail);
      await writer.close();
      sent?.();
    } catch (error) {
      await writer.abort(error);
    }
  };
  // Written as the request reads it.
  void write();
  return readable;
};

/**
 * The result of `call` sending `parts` as its multipart form, made again
 * for each attempt. A part that can't be read stops it with why. `sent`
 * is called once an attempt's whole form has gone out.
 */
const callWithForm = async <T>(
  api: CloudflareApi,
  call: ApiCall,
  parts: readonly FormPart[],
  schema: z.ZodType<T>,
  sent?: () => void
): Promise<T> => {
  const boundary = crypto.randomUUID();
  const failed = new AbortController();
  return await api.call(
    {
      ...call,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: () => formBody(boundary, parts, failed, sent),
      signal:
        call.signal === undefined
          ? failed.signal
          : AbortSignal.any([call.signal, failed.signal]),
    },
    schema
  );
};

/** The length of the base64 of `size` bytes. */
const base64Length = (size: number): number => Math.ceil(size / 3) * 4;

/**
 * Raw bytes of static files one assets upload carries. A file over it goes
 * alone, after the rest, with nothing else on its way.
 */
const assetRequestBytes = 8 * 1024 * 1024;

/** Assets uploads on their way at once, as Wrangler sends them. */
const assetRequestsAtOnce = 3;

/** A static file with the key it goes up under (`typedAssetKey`). */
interface KeyedAsset {
  file: AssetFile;
  hash: string;
}

/**
 * `files` in requests of up to `assetRequestBytes` raw, in order, and
 * apart from them each file over it.
 */
const assetRequests = (
  files: readonly KeyedAsset[]
): { shared: KeyedAsset[][]; alone: KeyedAsset[] } => {
  const shared: KeyedAsset[][] = [];
  const alone: KeyedAsset[] = [];
  let bytes = 0;
  for (const named of files) {
    const { size } = named.file;
    const last = shared.at(-1);
    if (size > assetRequestBytes) {
      alone.push(named);
    } else if (last === undefined || bytes + size > assetRequestBytes) {
      shared.push([named]);
      bytes = size;
    } else {
      last.push(named);
      bytes += size;
    }
  }
  return { shared, alone };
};

/**
 * Uploads the static files `files` the script `target` names serves that
 * the account doesn't hold yet, and returns the token its upload names
 * them by (`WorkerUpload.assetsJwt`). They change nothing a script runs
 * until an upload names them, so they go before it, not as part of it:
 * the upload session is opened under the script's own path, and the files
 * go to the account's upload. Every call goes with `options` (`ApiCall`'s
 * `signal` and `beforeSend`).
 */
export const uploadTargetAssets = async (
  api: CloudflareApi,
  target: ScriptTarget,
  files: readonly AssetFile[],
  options: Pick<ApiCall, "signal" | "beforeSend"> = {}
): Promise<string> => {
  const { accountId } = target;
  const scriptAt = targetPath(target);
  // Named by the key the release manifest gives each file (Wrangler's
  // shape and extension rule, with SHA-256) bound to its type: the account
  // keeps a file it holds under its key with the type it was first
  // uploaded with, so a file whose type changes must go up again under a
  // new key. A file is read, and its key checked, only if it goes up.
  const named = await Promise.all(
    files.map(async (file) => ({
      file,
      hash: await typedAssetKey(file.key, file.type),
    }))
  );
  const session = await api.call(
    {
      ...options,
      method: "POST",
      path: `${scriptAt}/assets-upload-session`,
      json: {
        manifest: Object.fromEntries(
          named.map(({ file, hash }) => [file.path, { hash, size: file.size }])
        ),
      },
    },
    uploadSessionSchema
  );
  const buckets = session.buckets ?? [];
  const byHash = new Map(named.map(({ file, hash }) => [hash, file]));
  // A hash asked for that isn't ours goes unanswered, and the upload then
  // ends without a completion token.
  const missing = buckets.flat().flatMap((hash) => {
    const file = byHash.get(hash);
    return file === undefined ? [] : [{ file, hash }];
  });
  // How much of a release the account already holds, counts only: whether
  // Cloudflare keeps static files per script or for the whole account
  // decides whether each client's deploy sends a release's new files again.
  log.info("deploy.assets_session", {
    script: target.scriptName,
    files: files.length,
    bytes: files.reduce((total, { size }) => total + size, 0),
    asked: missing.length,
    askedBytes: missing.reduce((total, { file }) => total + file.size, 0),
  });
  if (buckets.length === 0) {
    // The account holds every file: the session's token completes it.
    return session.jwt;
  }
  // Grouped by our own byte count rather than the session's buckets, whose
  // size isn't documented: one could hold tens of MB of base64. A request
  // reads its files one at a time as it goes out, so three on their way
  // hold at most three files of up to `assetRequestBytes`, and a larger
  // one goes with nothing else. The upload that completes the set answers
  // with the token.
  let completion: string | undefined;
  const send = async (request: readonly KeyedAsset[]): Promise<void> => {
    const uploaded = await callWithForm(
      api,
      {
        ...options,
        method: "POST",
        path: `/accounts/${accountId}/workers/assets/upload`,
        query: { base64: "true" },
        bearer: session.jwt,
        // Files are named by their content's hash: sending them again
        // stores the same files.
        idempotent: true,
      },
      request.map(({ file, hash }) => ({
        name: hash,
        type: file.type,
        size: base64Length(file.size),
        read: file.readBase64,
      })),
      uploadedSchema
    );
    if (typeof uploaded?.jwt === "string") {
      completion = uploaded.jwt;
    }
  };
  const { shared, alone } = assetRequests(missing);
  await mapConcurrently(shared, assetRequestsAtOnce, send);
  for (const file of alone) {
    // oxlint-disable-next-line no-await-in-loop -- one large file in memory at a time
    await send([file]);
  }
  if (completion === undefined) {
    throw new TypeError(
      "The assets upload finished without a completion token"
    );
  }
  return completion;
};

/** One of a Worker's deployments, as Cloudflare names its versions. */
const deploymentSchema = z.object({
  id: z.string(),
  created_on: z.string(),
  versions: z.array(
    z.object({ version_id: z.string(), percentage: z.number() })
  ),
});
export type WorkerDeployment = z.infer<typeof deploymentSchema>;

/** A Worker secret. */
export interface Secret {
  name: string;
  value: string;
}

/**
 * Bindings an upload keeps from the script's latest version, as Wrangler
 * asks: the secrets, which are delivered after it by name.
 */
const keptBindings = ["secret_text", "secret_key"];

/**
 * The upload's form: the metadata, then each module under its name. It
 * keeps the latest version's secrets.
 */
const uploadForm = ({
  releaseId,
  metadata,
  modules,
  assetsJwt,
}: WorkerUpload): FormPart[] => {
  const bindings: unknown[] = Array.isArray(metadata.bindings)
    ? metadata.bindings
    : [];
  const json = encoder.encode(
    JSON.stringify({
      ...metadata,
      bindings,
      keep_bindings: keptBindings,
      ...(assetsJwt === undefined
        ? {}
        : { assets: { ...metadata.assets, jwt: assetsJwt } }),
      annotations: {
        "workers/tag": releaseId,
        "workers/message": `Release ${releaseId}`,
      },
    })
  );
  return [
    {
      name: "metadata",
      type: "application/json",
      size: json.byteLength,
      read: async () => await Promise.resolve(json),
    },
    ...modules.map(({ name, type, size, stream }) => ({
      name,
      type,
      size,
      read: stream,
    })),
  ];
};

const serviceSchema = z.object({
  default_environment: z.object({
    script: z.object({ migration_tag: z.string().nullish() }),
  }),
});

/**
 * Whether `scriptName` exists, and the tag of the last Durable Object
 * migration it ran, if any: what decides which of a release's migrations
 * its next upload carries. Read as Wrangler reads it.
 */
export const scriptMigrationState = async (
  api: CloudflareApi,
  accountId: string,
  scriptName: string
): Promise<{ exists: boolean; migrationTag?: string }> => {
  try {
    const { default_environment: environment } = await api.call(
      {
        method: "GET",
        path: `/accounts/${accountId}/workers/services/${scriptName}`,
      },
      serviceSchema
    );
    const tag = environment.script.migration_tag;
    return {
      exists: true,
      ...(tag === null || tag === undefined || tag === ""
        ? {}
        : { migrationTag: tag }),
    };
  } catch (error) {
    if (isNotFound(error)) {
      return { exists: false };
    }
    throw error;
  }
};

const queryResultSchema = z.array(
  z.object({
    success: z.boolean(),
    results: z.array(z.record(z.string(), z.unknown())),
  })
);

/** A statement that failed inside an answer that succeeded. */
export class D1StatementError extends Error {
  constructor(databaseId: string, failed: number, of: number) {
    super(`D1 query on ${databaseId} failed at statement ${failed} of ${of}`);
    this.name = "D1StatementError";
  }
}

/**
 * Whether D1 refused the SQL itself: a 400, or a statement that failed
 * inside an answer. Anything else (no answer, a 429 or 5xx the API client
 * gave up on, a runner's check that it still holds its client) isn't the
 * SQL's.
 */
const refusedSql = (error: unknown): boolean =>
  error instanceof D1StatementError ||
  (error instanceof CloudflareApiError && error.status === 400);

/**
 * Runs `sql`, one or more statements, on the D1 database `databaseId` as
 * one request; returns each statement's rows.
 */
export const queryD1 = async (
  api: CloudflareApi,
  accountId: string,
  databaseId: string,
  sql: string,
  beforeSend?: () => Promise<void>
): Promise<Record<string, unknown>[][]> => {
  const statements = await api.call(
    {
      method: "POST",
      path: `/accounts/${accountId}/d1/database/${databaseId}/query`,
      json: { sql },
      ...(beforeSend === undefined ? {} : { beforeSend }),
    },
    queryResultSchema
  );
  // A statement can fail inside an answer that succeeded.
  const failed = statements.findIndex(({ success }) => !success);
  if (failed !== -1) {
    throw new D1StatementError(databaseId, failed + 1, statements.length);
  }
  return statements.map(({ results }) => results);
};

/** A D1 migration: its file's name and SQL, as `readD1Migrations` reads them. */
export interface D1Migration {
  name: string;
  sql: string;
}

/** A SQL string literal of `text`. */
const sqlText = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/**
 * Before each send of a migration, its retries included: throws to stop
 * it unsent, as a runner that no longer holds its client does.
 */
export type BeforeMigration = () => Promise<void>;

/**
 * The most SQL one query of migrations carries, in bytes: a client's
 * first deploy applies every migration (about 270, some 230 KB in all),
 * which one query each took minutes to send, and this makes a handful.
 * Well under what D1 runs in its 30 s, and each statement stays within its
 * 100 KB as it is: a migration over this goes alone.
 */
const migrationQueryBytes = 64 * 1024;

const sqlEncoder = new TextEncoder();

/** `migration` with its record after it, as one query's SQL. */
const recorded = ({ name, sql }: D1Migration): string =>
  `${sql}\nINSERT INTO d1_migrations (name) VALUES (${sqlText(name)});`;

/** `pending`, in order, in groups of up to `migrationQueryBytes` each. */
const migrationBatches = (pending: readonly D1Migration[]): D1Migration[][] => {
  const batches: D1Migration[][] = [];
  let bytes = 0;
  for (const migration of pending) {
    const size = sqlEncoder.encode(recorded(migration)).byteLength;
    const last = batches.at(-1);
    if (last !== undefined && bytes + size <= migrationQueryBytes) {
      last.push(migration);
      bytes += size;
    } else {
      batches.push([migration]);
      bytes = size;
    }
  }
  return batches;
};

/** The names of the migrations database `databaseId` has recorded. */
const recordedNames = async (
  api: CloudflareApi,
  accountId: string,
  databaseId: string
): Promise<Set<string>> => {
  const [, applied = []] = await queryD1(
    api,
    accountId,
    databaseId,
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); SELECT name FROM d1_migrations;"
  );
  return new Set(applied.map(({ name }) => String(name)));
};

/**
 * Applies `batch` in one query, each migration with its record right
 * after it. Should D1 refuse the query, which of its migrations it refused
 * isn't said, and whether those before it went through isn't documented:
 * so the ones it didn't record go again one to a query, from the first, and
 * the one D1 refuses then is named (`D1MigrationError`).
 */
const applyBatch = async (
  api: CloudflareApi,
  accountId: string,
  databaseId: string,
  batch: readonly D1Migration[],
  before: BeforeMigration
): Promise<void> => {
  const send = async (migrations: readonly D1Migration[]) => {
    // Checked before each send of it, the API client's retries included: a
    // 429 waited out must not let a runner that lost its client send it.
    await queryD1(
      api,
      accountId,
      databaseId,
      migrations.map(recorded).join("\n"),
      before
    );
  };
  try {
    await send(batch);
    return;
  } catch (error) {
    if (!refusedSql(error)) {
      throw error;
    }
    const [only] = batch;
    if (batch.length === 1 && only !== undefined) {
      throw new D1MigrationError(only.name, error);
    }
  }
  const done = await recordedNames(api, accountId, databaseId);
  for (const migration of batch.filter(({ name }) => !done.has(name))) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- in order, each after the last
      await send([migration]);
    } catch (error) {
      if (!refusedSql(error)) {
        throw error;
      }
      throw new D1MigrationError(migration.name, error);
    }
  }
};

/**
 * Applies `pending` in order, each with its record right after it, a few
 * to a query (`migrationBatches`, `applyBatch`), stopping at the first
 * migration D1 refuses, and checking `before` before each send of each.
 */
const applyInOrder = async (
  api: CloudflareApi,
  accountId: string,
  databaseId: string,
  pending: readonly D1Migration[],
  before: BeforeMigration
): Promise<void> => {
  for (const batch of migrationBatches(pending)) {
    // oxlint-disable-next-line no-await-in-loop -- in order, each after the last
    await applyBatch(api, accountId, databaseId, batch, before);
  }
};

/**
 * Applies the migrations the database hasn't had, in order, and returns
 * their names. They're recorded as Wrangler records them (its
 * `d1_migrations` table), so the admin and `wrangler d1 migrations`
 * agree on what was applied. Each migration's record goes right after it,
 * in the same query, as Wrangler sends them, a few migrations to a query.
 * The API doesn't document whether such a query is atomic: a failure part
 * way could leave those before it applied and recorded, and the one that
 * failed half applied and unrecorded (threat model CO13). The first that
 * D1 refuses stops the rest, and is named (`D1MigrationError`). `before`
 * is checked before each query: a runner's check that it still holds its
 * client, so one that lost it applies nothing more.
 */
export const applyD1Migrations = async (
  api: CloudflareApi,
  accountId: string,
  databaseId: string,
  migrations: readonly D1Migration[],
  before: BeforeMigration = async () => {
    await Promise.resolve();
  }
): Promise<string[]> => {
  const done = await recordedNames(api, accountId, databaseId);
  const pending = migrations.filter(({ name }) => !done.has(name));
  await applyInOrder(api, accountId, databaseId, pending, before);
  return pending.map(({ name }) => name);
};

/*
 * A placed client's scripts (src/hosting/operation.ts): in its hosting
 * destination's Workers for Platforms dispatch namespace. The calls are the
 * ones Cloudflare documents for user Workers, under
 * `/accounts/{account_id}/workers/dispatch/namespaces/{namespace}/scripts/{script_name}`:
 * the upload (`PUT`, multipart, as an account's own script upload, with
 * `keep_bindings`), the script's details (`GET`, whose
 * `script.migration_tag` is the last Durable Object migration it ran),
 * its static assets' upload session, and its secrets (`PUT` and `GET`
 * `.../secrets`). Nothing more is assumed of a namespace: qualifying these
 * on a real account is GRA-430's.
 */

/**
 * Deletes the script `target` names with what it binds of its own (its
 * Durable Object namespaces and their data: `force`). One that's gone
 * already counts as deleted.
 */
export const deleteTargetScript = async (
  api: CloudflareApi,
  target: ScriptTarget
): Promise<void> => {
  try {
    await api.call(
      { method: "DELETE", path: targetPath(target), query: { force: "true" } },
      z.unknown()
    );
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
};

/**
 * Uploads `upload` as the script `target` names, live at once (a dispatch
 * namespace has no gradual deployments), keeping the secrets its latest
 * version has (`keep_bindings`): a placed client's secrets are delivered
 * after it, by name (`putTargetSecret`). An upload that runs a Durable
 * Object migration isn't retried after a server error or no answer: if it
 * went through, its migration ran, and sending it again would be refused
 * on the migration's tag. The caller reads the script's migration tag to
 * find out. `sent` is called once the script's whole upload has gone out:
 * until then, Cloudflare can't have taken it.
 */
export const uploadTargetScript = async (
  api: CloudflareApi,
  target: ScriptTarget,
  upload: WorkerUpload,
  { signal, sent }: { signal?: AbortSignal; sent?: () => void } = {}
): Promise<void> => {
  await callWithForm(
    api,
    {
      method: "PUT",
      path: targetPath(target),
      idempotent: upload.metadata.migrations === undefined,
      ...(signal === undefined ? {} : { signal }),
    },
    uploadForm(upload),
    z.unknown(),
    sent
  );
};

// A script the namespace hasn't got answers 200 with a null `script` (the
// namespace's own details), not a 404, as a real namespace showed
// (GRA-430, 28 Oct).
const dispatchScriptSchema = z.object({
  script: z.object({ migration_tag: z.string().nullish() }).nullable(),
});

/**
 * Whether the script `target` names exists, and the last Durable Object
 * migration it ran: `scriptMigrationState` for an account's own, the
 * script's details for one in a namespace.
 */
export const targetMigrationState = async (
  api: CloudflareApi,
  target: ScriptTarget
): Promise<{ exists: boolean; migrationTag?: string }> => {
  if (target.namespace === null) {
    return await scriptMigrationState(api, target.accountId, target.scriptName);
  }
  try {
    const { script } = await api.call(
      { method: "GET", path: targetPath(target) },
      dispatchScriptSchema
    );
    if (script === null) {
      return { exists: false };
    }
    const tag = script.migration_tag;
    return {
      exists: true,
      ...(tag === null || tag === undefined || tag === ""
        ? {}
        : { migrationTag: tag }),
    };
  } catch (error) {
    if (isNotFound(error)) {
      return { exists: false };
    }
    throw error;
  }
};

/**
 * Sets the secret `secret` on the script `target` names. Its value goes
 * only into the request body, never into a path or an error.
 */
export const putTargetSecret = async (
  api: CloudflareApi,
  target: ScriptTarget,
  secret: Secret,
  { signal }: { signal?: AbortSignal } = {}
): Promise<void> => {
  await api.call(
    {
      method: "PUT",
      path: `${targetPath(target)}/secrets`,
      json: { name: secret.name, text: secret.value, type: "secret_text" },
      ...(signal === undefined ? {} : { signal }),
    },
    z.unknown()
  );
};

/**
 * Removes the secret `name` from the script `target` names. One that's
 * already gone counts as removed, so a retried step succeeds.
 */
export const deleteTargetSecret = async (
  api: CloudflareApi,
  target: ScriptTarget,
  name: string,
  { signal }: { signal?: AbortSignal } = {}
): Promise<void> => {
  try {
    await api.call(
      {
        method: "DELETE",
        path: `${targetPath(target)}/secrets/${encodeURIComponent(name)}`,
        ...(signal === undefined ? {} : { signal }),
      },
      z.unknown()
    );
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
};

/** The names of the secrets the script `target` names has; their values are never read. */
export const targetSecretNames = async (
  api: CloudflareApi,
  target: ScriptTarget
): Promise<string[]> => {
  const secrets = await api.call(
    { method: "GET", path: `${targetPath(target)}/secrets` },
    z.array(z.object({ name: z.string() }))
  );
  return secrets.map(({ name }) => name);
};
