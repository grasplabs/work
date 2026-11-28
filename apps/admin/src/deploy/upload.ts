import "@tanstack/react-start/server-only";
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { sha256Hex, toHex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
/**
 * One of a release's Workers as the Workers API takes it: its metadata
 * with the account's resources filled in, and its modules and static
 * files read from R2 and checked against the manifest. Its secrets are in
 * src/deploy/secrets.ts.
 */
import { d1IdPlaceholder } from "@grasp-os/shared/release";
import type { ReleaseManifest, WorkerEntry } from "@grasp-os/shared/release";
import mime from "mime";
import { z } from "zod";

import type {
  AssetFile,
  ScriptTarget,
  Secret,
  TargetSettings,
  TargetState,
  WorkerMetadata,
  WorkerModule,
  WorkerUpload,
} from "../cloudflare/workers.ts";
import type { ReleaseStore } from "../releases/import.ts";
import { DeployError } from "./errors.ts";
import { readAssetBase64, streamBlob } from "./release.ts";

const unknownPlaceholder = (worker: WorkerEntry, binding: string) =>
  new DeployError(
    "unknown_placeholder",
    `${worker.name}'s binding ${binding} names a placeholder the admin doesn't fill`
  );

/**
 * `binding`, if it's a `send_email` binding, locked to send from
 * `mailSender` alone (`allowed_sender_addresses`), whatever it said.
 */
export const lockMailSender = (
  binding: Record<string, unknown>,
  mailSender: string
): void => {
  if (binding.type === "send_email") {
    binding.allowed_sender_addresses = [mailSender];
  }
};

/**
 * `worker`'s bindings with each D1 binding's id filled in: a D1 binding's
 * `id` must be exactly its own placeholder (`d1IdPlaceholder`), for a
 * database the Worker lists, and is replaced by that database's id in the
 * account. The placeholder list is closed: any other `$` value is refused
 * (`unknown_placeholder`), so the manifest and this change together.
 *
 * Every `send_email` binding is locked to `mailSender`, the onboarding
 * sender's address (src/deploy/core-config.ts): it sends from that address
 * alone (`allowed_sender_addresses`), whatever the manifest says, so no
 * code that reaches the binding sends as anyone else from the client's
 * domain. Limits on whom it sends to, should a release set any, stay.
 */
export const renderBindings = (
  worker: WorkerEntry,
  databases: ReadonlyMap<string, string>,
  mailSender: string
): Record<string, unknown>[] =>
  worker.bindings.map((binding) => {
    const rendered: Record<string, unknown> = { ...binding };
    lockMailSender(rendered, mailSender);
    if (binding.type === "d1") {
      const database = worker.d1Databases.find(
        (entry) => entry.binding === binding.name
      );
      const id =
        database === undefined
          ? undefined
          : databases.get(database.databaseName);
      if (binding.id !== d1IdPlaceholder(binding.name) || id === undefined) {
        throw unknownPlaceholder(worker, binding.name);
      }
      rendered.id = id;
    }
    for (const value of Object.values(rendered)) {
      if (typeof value === "string" && value.startsWith("$")) {
        throw unknownPlaceholder(worker, binding.name);
      }
    }
    return rendered;
  });

/**
 * The API's content type for each module type in the manifest. A source
 * map goes up as Wrangler sends it, beside the module it maps.
 */
const moduleTypes = {
  esm: "application/javascript+module",
  text: "text/plain",
  wasm: "application/wasm",
  data: "application/octet-stream",
  sourcemap: "application/source-map",
} as const;

/**
 * The type a static file at `path` is uploaded with, and so served with:
 * Wrangler's own rule (workers-shared's `getContentType`), so a client's
 * core serves its files as `wrangler deploy` and local dev do. Core checks
 * the type of what it reads from its assets before it runs it (the
 * compiler's `esbuild.wasm` must be `application/wasm`), so a type that
 * differs from Wrangler's breaks only in a client account. A file
 * Wrangler leaves untyped goes up as `application/octet-stream`.
 */
const assetType = (path: string): string => {
  const type = mime.getType(path) ?? "application/octet-stream";
  return type.startsWith("text/") ? `${type}; charset=utf-8` : type;
};

/**
 * `worker`'s static files, if it serves any, each read from R2 and checked
 * against the key the manifest gives it only as it's uploaded
 * (`AssetFile`, `uploadTargetAssets`).
 */
export const workerAssets = (
  store: ReleaseStore,
  worker: WorkerEntry
): AssetFile[] | undefined =>
  worker.assets === undefined
    ? undefined
    : Object.entries(worker.assets.manifest).map(([path, { hash, size }]) => ({
        path,
        key: hash,
        size,
        type: assetType(path),
        readBase64: async () =>
          await readAssetBase64(store, { path, key: hash, size }),
      }));

/**
 * When a Worker's live Durable Objects take up the code an upload brings:
 * each runs its current code until it hibernates (no request, event, timer,
 * pending call or standard WebSocket left), and is reset onto the new code
 * only if it is still busy `max_delay` seconds after the upload. So a chat
 * answering as a deploy lands finishes its turn on the code it began with,
 * an idle object takes the new code while it sleeps, and its hibernated
 * WebSockets stay connected. Cloudflare defers by 300 s by default; 900 s
 * is the longest the platform keeps an object up for one pending operation
 * and the alarm's wall time (15 minutes), so any turn segment the platform
 * would carry finishes on the old code, and the mix of versions in one
 * client lasts no longer than that. A turn longer than that resets and
 * picks up where it stored. Code must hold for that mix: the D1 schema the
 * deploy migrated first is read by objects still on the code before it.
 *
 * A deployment's setting, not the Worker's (it "does not carry over between
 * deployments"): an upload to a dispatch namespace deploys at once, so it
 * rides in every upload's metadata, a rotation's and a settings apply's
 * re-upload too, or that deploy falls back to the default. One setting
 * covers every class of the Worker.
 */
export const durableObjectCodeUpdate = {
  mode: "deferred",
  max_delay: 900,
} as const;

/**
 * The subrequests one invocation of a client's Worker may make. A tab's
 * connection to core (`/rpc`) is one invocation for as long as the tab is
 * open, and every D1 query and object call its calls and pushes make
 * counts towards it. Cloudflare's default is 10,000: a tab in steady use
 * (a call every 2 s at about 5 subrequests each, and a session reading of
 * 4 queries every 5 s while it is in use, about 3.3 a second) reaches it
 * in under an hour, after which every call it makes fails. At 1,000,000 a
 * tab in that use lasts about 84 hours of it, more than a working week;
 * Workers Paid allows up to 10,000,000. One limit for every Worker of the
 * client: an invocation of connect's never comes near it.
 */
export const workerLimits = { subrequests: 1_000_000 } as const;

/**
 * What `worker` of `manifest` is uploaded as, `bindings` rendered already:
 * a placed client's, mapped onto its inventory (src/hosting/inventory.ts),
 * its mail locked (`lockMailSender`). Its metadata on the release's
 * compatibility date and flags, `vars` added as JSON bindings, `secrets`
 * as secret bindings, and its modules, each read from `store` and checked
 * against the manifest as the upload sends it. Its static files go up
 * before it (`workerAssets`).
 *
 * The secrets go in the upload itself, as the API takes them: one version
 * with all of them, and exactly them, so no version ever runs without one
 * or with one it's no longer given.
 */
export const renderedWorkerUpload = (
  store: ReleaseStore,
  manifest: ReleaseManifest,
  worker: WorkerEntry,
  bindings: readonly Record<string, unknown>[],
  vars: Readonly<Record<string, unknown>>,
  secrets: readonly Secret[]
): WorkerUpload => {
  const modules = worker.modules.map((file): WorkerModule => ({
    name: file.name,
    type: moduleTypes[file.type],
    size: file.size,
    stream: async () => await streamBlob(store, file),
  }));
  const metadata: WorkerMetadata = {
    main_module: worker.mainModule,
    compatibility_date: manifest.compatibilityDate,
    compatibility_flags: worker.compatibilityFlags,
    bindings: [
      ...bindings,
      ...Object.entries(vars).map(([name, json]) => ({
        type: "json",
        name,
        json,
      })),
      ...secrets.map(({ name, value }) => ({
        type: "secret_text",
        name,
        text: value,
      })),
    ],
    observability: worker.observability,
    code_update_strategy: durableObjectCodeUpdate,
    limits: workerLimits,
    ...(worker.assets === undefined
      ? {}
      : { assets: { config: worker.assets.config } }),
  };
  return { releaseId: manifest.releaseId, metadata, modules };
};

/**
 * Throws `binding_name_taken` unless every binding, var and secret of
 * `worker` has a name of its own: a setting named like a binding or a
 * secret, or a shared secret named like a binding, would replace it.
 */
export const checkBindingNames = (
  worker: WorkerEntry,
  vars: Readonly<Record<string, unknown>>,
  secrets: readonly Secret[]
): void => {
  const bindings = new Set(worker.bindings.map(({ name }) => name));
  const secretNames = new Set(secrets.map(({ name }) => name));
  const taken =
    Object.keys(vars).find(
      (name) => bindings.has(name) || secretNames.has(name)
    ) ?? [...secretNames].find((name) => bindings.has(name));
  if (taken !== undefined) {
    throw new DeployError(
      "binding_name_taken",
      `${worker.name} has more than one binding named ${taken}`
    );
  }
};

const encoder = new TextEncoder();

/** HMAC-SHA256 of `inputs`, as canonical JSON, under `key`: hex. */
export const keyedHash = async (
  key: CryptoKey,
  inputs: unknown
): Promise<string> => {
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(canonicalJson(z.json().parse(inputs)))
  );
  return toHex(new Uint8Array(mac));
};

/** What the key secrets fingerprints are made with is derived for. */
const secretsFingerprintPurpose = "grasp-os console secrets fingerprint";

/** Secrets as `[name, value]` pairs, by name. */
const sortedSecrets = (secrets: readonly Secret[]): [string, string][] =>
  secrets
    .map(({ name, value }): [string, string] => [name, value])
    .toSorted(([a], [b]) => (a < b ? -1 : 1));

/**
 * A fingerprint of `secrets` alone, names and values: HMAC-SHA256 under a
 * key HKDF derives from `key` (`CLIENT_KEY`) for this purpose alone, so it
 * tells nothing about the values and never passes for another MAC. Of a
 * Worker's secrets: two versions with the same one may share traffic
 * (src/rollout/workflow.ts). Of its shared secrets: whether a version
 * runs the ones in Secrets Store now (src/rollout/shared-secrets.ts).
 */
export const secretsFingerprint = async (
  key: string,
  secrets: readonly Secret[]
): Promise<string> =>
  await keyedHash(await hkdfHmacKey(key, secretsFingerprintPurpose, ["sign"]), {
    secrets: sortedSecrets(secrets),
  });

/** What an upload's fingerprint is keyed with, derived from `CLIENT_KEY` for it alone. */
const uploadFingerprintPurpose = "grasp-os console placed upload fingerprint";

/**
 * A fingerprint of everything `upload`, Worker `worker`'s as
 * `renderedWorkerUpload` made it, sends to `target`: its metadata (the
 * compatibility date and flags, its bindings as rendered for the client
 * and its vars, its settings), its modules and static files by their
 * digests, its Durable Object migrations, and its secrets' names and
 * values (`secrets`, through their own keyed fingerprint, never as they
 * are). HMAC-SHA256 under a key HKDF derives from `clientKey` for this
 * purpose alone, so the recorded fingerprint tells nothing of the values.
 *
 * Not the release: a release whose Worker sends exactly what the last
 * upload did leaves it be (src/hosting/operation.ts, `upload`), so its
 * Durable Objects aren't reset for nothing. It's taken from what goes out
 * rather than from what goes into it, so anything the admin renders
 * differently changes it too.
 */
export const uploadFingerprint = async (
  clientKey: string,
  {
    target,
    worker,
    upload,
    secrets,
  }: {
    target: ScriptTarget;
    worker: WorkerEntry;
    upload: WorkerUpload;
    secrets: readonly Secret[];
  }
): Promise<string> => {
  const bindings: unknown[] = Array.isArray(upload.metadata.bindings)
    ? upload.metadata.bindings
    : [];
  return await keyedHash(
    await hkdfHmacKey(clientKey, uploadFingerprintPurpose, ["sign"]),
    {
      target,
      metadata: {
        ...upload.metadata,
        bindings: bindings.filter(
          (binding) =>
            typeof binding !== "object" ||
            binding === null ||
            !("type" in binding) ||
            binding.type !== "secret_text"
        ),
      },
      modules: worker.modules.map(({ name, type, sha256 }) => [
        name,
        type,
        sha256,
      ]),
      assets: worker.assets?.manifest ?? null,
      durableObjectMigrations: worker.durableObjectMigrations,
      secrets: await secretsFingerprint(clientKey, secrets),
    }
  );
};

/**
 * A digest of a script as Cloudflare reads it back: `state`, its code's
 * digest and when it was last modified, and `settings`, its bindings (a
 * secret by name), compatibility, limits and observability. Recorded after
 * an upload and compared before the next (src/hosting/operation.ts,
 * `runsAlready`), so a change made beside the admin's (a binding or
 * setting changed by hand, a secret set, the script put again or deleted
 * and made anew) makes the next run upload it whole, whatever the admin
 * recorded. Nothing secret goes into it.
 */
export const liveDigest = async (
  state: TargetState,
  settings: TargetSettings
): Promise<string> =>
  await sha256Hex(
    canonicalJson(
      z.json().parse({
        etag: state.etag ?? null,
        modifiedOn: state.modifiedOn ?? null,
        migrationTag: state.migrationTag ?? null,
        settings,
      })
    )
  );
