import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { toHex } from "@grasp-os/shared/encoding";
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
  Secret,
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

/** The API's content type for each module type in the manifest. */
const moduleTypes = {
  esm: "application/javascript+module",
  text: "text/plain",
  wasm: "application/wasm",
  data: "application/octet-stream",
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
 * `worker`'s static files, each read from R2 and checked against the key
 * the manifest gives it only as it's uploaded (`AssetFile`).
 */
const assetsOf = (store: ReleaseStore, worker: WorkerEntry): AssetFile[] =>
  Object.entries(worker.assets?.manifest ?? {}).map(
    ([path, { hash, size }]) => ({
      path,
      key: hash,
      size,
      type: assetType(path),
      readBase64: async () =>
        await readAssetBase64(store, { path, key: hash, size }),
    })
  );

/**
 * What `worker` of `manifest` is uploaded as, `bindings` rendered already:
 * a placed client's, mapped onto its inventory (src/hosting/inventory.ts),
 * its mail locked (`lockMailSender`). Its metadata on the release's
 * compatibility date and flags, `vars` added as JSON bindings, and its
 * modules and static files, each read from `store` and checked against
 * the manifest as the upload sends it.
 */
export const renderedWorkerUpload = (
  store: ReleaseStore,
  manifest: ReleaseManifest,
  worker: WorkerEntry,
  bindings: readonly Record<string, unknown>[],
  vars: Readonly<Record<string, unknown>>
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
    ],
    observability: worker.observability,
    ...(worker.assets === undefined
      ? {}
      : { assets: { config: worker.assets.config } }),
  };
  return {
    releaseId: manifest.releaseId,
    metadata,
    modules,
    ...(worker.assets === undefined ? {} : { assets: assetsOf(store, worker) }),
  };
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

/** What goes into one Worker's upload, as `uploadFingerprint` takes it. */
export interface UploadInputs {
  manifest: ReleaseManifest;
  worker: WorkerEntry;
  databases: ReadonlyMap<string, string>;
  vars: Readonly<Record<string, unknown>>;
  secrets: readonly Secret[];
  /** The address its mail is locked to (`renderBindings`). */
  mailSender: string;
}

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

/** `key` as an HMAC-SHA256 key, as it is. */
const rawHmacKey = async (key: string): Promise<CryptoKey> =>
  await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

/** What the key secrets fingerprints are made with is derived for. */
const secretsFingerprintPurpose = "grasp-os console secrets fingerprint";

/** Secrets as `[name, value]` pairs, by name. */
const sortedSecrets = (secrets: readonly Secret[]): [string, string][] =>
  secrets
    .map(({ name, value }): [string, string] => [name, value])
    .toSorted(([a], [b]) => (a < b ? -1 : 1));

/**
 * A fingerprint of everything that goes into a Worker's upload: its
 * secrets' names and values (the previous keys included, when given), its
 * vars, its bindings as filled in for the account, its code, static files,
 * settings and pins. HMAC-SHA256 under `key` (`CLIENT_KEY`), so the
 * fingerprint stored with a recorded version tells nothing about the
 * secret values that went into it. A resumed deploy reuses a version only
 * while this is the same.
 */
export const uploadFingerprint = async (
  key: string,
  { manifest, worker, databases, vars, secrets, mailSender }: UploadInputs
): Promise<string> =>
  await keyedHash(await rawHmacKey(key), {
    compatibilityDate: manifest.compatibilityDate,
    compatibilityFlags: worker.compatibilityFlags,
    mainModule: worker.mainModule,
    modules: worker.modules.map(({ name, type, sha256 }) => [
      name,
      type,
      sha256,
    ]),
    assets: worker.assets ?? null,
    observability: worker.observability,
    durableObjectMigrations: worker.durableObjectMigrations,
    bindings: renderBindings(worker, databases, mailSender),
    vars,
    secrets: sortedSecrets(secrets),
  });

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
