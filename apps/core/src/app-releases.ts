import {
  appModuleName,
  compilerVersion,
  isAppLayout,
  kitModuleName,
  kitModules,
  sdkModules,
} from "@grasp-os/compiler";
import type { Diagnostic } from "@grasp-os/compiler";
import {
  contractFingerprints,
  contractsFormatVersion,
  generatedPaths,
  generateModules,
  manifestText,
  manifestVersion,
  readAppManifest,
  schemaHash,
  serverModuleSource,
  symbolicModules,
} from "@grasp-os/sdk/host";
import type { AppManifest } from "@grasp-os/sdk/host";
import {
  releaseFormatVersion,
  releaseManifestSchema,
  sdkProtocolVersion,
  versionErrors,
} from "@grasp-os/shared/app-releases";
import type {
  DataStoreBinding,
  ReleaseArtifact,
  ReleaseManifest,
} from "@grasp-os/shared/app-releases";
import { actorOf } from "@grasp-os/shared/audit";
import { sha256Hex, toHex } from "@grasp-os/shared/encoding";
import type { AppId, StoreId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { findVersion, versionFiles } from "./apps.ts";
import { auditedBatch, outboxed } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import { openStore } from "./data-stores.ts";
import {
  sdkArtifactDeletions,
  sdkReleaseManifests,
  sdkReleaseTombstones,
  sdkResourceBindings,
  sdkStoreOwners,
} from "./db/core/schema.ts";
import { isUniqueViolation } from "./db/d1.ts";
import { finishDeletion, markArtifact } from "./release-retention.ts";
import { sandbox } from "./sandbox.ts";
import { buildAppCode } from "./screens.ts";

// Sealing an App's release (spec 8, 16): turning one version of an App of
// spec 8's layout into an immutable manifest and the content-addressed
// artifacts it names, which every invocation then runs from. Threat
// model, and how each is closed:
//
// - App code runs while it is inspected: only in Loader isolates with no
//   network, no env and a CPU limit (`sandbox`), never in core. What they
//   answer is hostile text, read by declaring the App again through the
//   SDK's constructors (`readAppManifest`), which refuses anything no
//   declaration makes.
// - The registration depends on references that don't exist yet: the
//   first inspection lends symbolic ones, which resolve only against the
//   registration; the host then generates the real modules from what it
//   read, builds the code again with them, inspects it again, and refuses
//   to seal unless both inspections read exactly the same (`unstable`).
//   Nothing symbolic is sealed.
// - A release is changed after it was sealed: its manifest is canonical
//   text stored once with its SHA-256 (a second seal of the version with
//   another manifest is refused), and every artifact is stored under the
//   SHA-256 of its bytes, the SDK modules it was inspected with among
//   them, so it runs the SDK it was sealed with whatever SDK the host
//   serves later. Loading reads it all back and checks every hash,
//   the manifest's, each artifact's and the contracts' (`loadRelease`).
//   A new version is a new manifest; a sealed one never changes.
// - A release reaches a store it shouldn't: no App code, request or
//   manifest field names a store. The host that seals binds one, and
//   records the binding apart from the manifest
//   (`sdk_resource_bindings`); loading requires both to agree. A store
//   serves one App for good: the first seal claims it
//   (`sdk_store_owners`) before defining its tables, and retention never
//   deletes the claim.
// - A release vouches for itself: its trust is always `unreviewed` in the
//   manifest; approval and revocation are the host's records of its hash.

/** Where an artifact's bytes are, by their SHA-256. */
const artifactKey = (sha256: string): string => `release-artifacts/${sha256}`;

/** The most characters an inspection may answer: an App manifest's bound. */
const inspectionMaxLength = 4 * 1024 * 1024;

/** The module that inspects the App in its isolate. */
const inspectModule = "grasp-inspect.js";

/**
 * The inspection isolate's main module: the App's registration as JSON
 * text, through the SDK's runner. Everything in the isolate is
 * untrusted, this module too; it only bounds what it hands back.
 */
const inspectMain = `import { WorkerEntrypoint } from "cloudflare:workers";
import { manifestOfApp } from ${JSON.stringify(kitModuleName("@grasp-os/sdk/runner"))};
import registered from ${JSON.stringify(appModuleName("app.ts"))};

export class Inspect extends WorkerEntrypoint {
  manifest() {
    const text = manifestOfApp(registered);
    if (typeof text !== "string" || text.length > ${inspectionMaxLength}) {
      throw new Error("The App's manifest is too large.");
    }
    return text;
  }
}
`;

interface InspectEntrypoint extends Rpc.WorkerEntrypointBranded {
  manifest: () => Promise<string>;
}

/** The most of why App code failed that a refusal keeps. */
const maxFailure = 500;

/** The details of a refused build: where and why, as diagnostics say. */
const buildDetails = (diagnostics: readonly Diagnostic[]) => ({
  diagnostics: diagnostics.slice(0, 50).map(({ file, line, message }) => ({
    file: file ?? null,
    line: line ?? null,
    message: message.slice(0, maxFailure),
  })),
});

/**
 * The App's code in `files` built with the host's generated modules,
 * as modules by flat name; `version.build_failed` with diagnostics if it
 * doesn't build.
 */
const builtCode = async (
  env: Env,
  files: Readonly<Record<string, string>>
): Promise<Record<string, string>> => {
  const build = await buildAppCode(env, { ...files });
  if (!build.ok) {
    throw versionErrors.create(
      "version.build_failed",
      buildDetails(build.diagnostics)
    );
  }
  return build.modules;
};

/**
 * What the App's registration answers when `modules` load in an isolate
 * of their own, with the SDK's: its manifest's text, or
 * `version.inspection_failed` with what the App's code threw.
 */
const inspected = async (
  env: Env,
  modules: Readonly<Record<string, string>>,
  sdk: Readonly<Record<string, string>>
): Promise<string> => {
  const isolate = env.LOADER.get(null, () => ({
    ...sandbox,
    mainModule: inspectModule,
    // The platform's modules last: no App module takes one's name.
    modules: { ...modules, ...sdk, [inspectModule]: inspectMain },
    env: {},
  })).getEntrypoint<InspectEntrypoint>("Inspect");
  let text: unknown;
  try {
    text = await isolate.manifest();
  } catch (error) {
    throw versionErrors.create("version.inspection_failed", {
      message: (error instanceof Error ? error.message : "").slice(
        0,
        maxFailure
      ),
    });
  }
  if (typeof text !== "string") {
    throw versionErrors.create("version.inspection_failed", {
      message: "The inspection answered something that isn't text.",
    });
  }
  return text;
};

/**
 * The App manifest in `text`, as the host reads it (`readAppManifest`):
 * `version.invalid_manifest` with the SDK's reason for anything else.
 */
const readManifest = (text: string): AppManifest => {
  try {
    return readAppManifest(text);
  } catch (error) {
    throw versionErrors.create("version.invalid_manifest", {
      message: (error instanceof Error ? error.message : "").slice(
        0,
        maxFailure
      ),
    });
  }
};

/** The canonical text of JSON data. */
const canonicalText = (value: unknown): string => {
  // SAFETY: what JSON.parse answers is JSON; everything read here (a
  // manifest, a report) is JSON data to begin with.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const json = JSON.parse(JSON.stringify(value) ?? "null") as Json;
  return canonicalJson(json);
};

const encoder = new TextEncoder();

/** The SHA-256, in hex, of `bytes`. */
const sha256Of = async (bytes: ArrayBuffer | Uint8Array): Promise<string> =>
  toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));

/** One artifact, as the manifest names it, and the bytes hashed. */
interface Artifact {
  readonly entry: ReleaseArtifact;
  readonly bytes: Uint8Array;
}

/** `text` as the artifact at `path`: its UTF-8 bytes, as stored. */
const artifactOf = async (path: string, text: string): Promise<Artifact> => {
  const bytes = encoder.encode(text);
  return {
    entry: { path, sha256: await sha256Of(bytes), bytes: bytes.byteLength },
    bytes,
  };
};

/** `value` with every object and array in it frozen. */
const deepFreeze = <Value>(value: Value): Value => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
  }
  return value;
};

/** What the host that seals a release gives it. */
export interface SealRequest {
  readonly app: AppId;
  readonly version: number;
  /**
   * The store the release reads and writes, which the host chose: needed
   * when the App declares tables, and never anything App code names.
   */
  readonly store?: StoreId;
  readonly by: Pick<Acting, "userId" | "staff" | "actor">;
}

/** A release as the host runs it: verified, every hash checked. */
export interface Release {
  readonly manifest: ReleaseManifest;
  readonly manifestHash: string;
  /** The App's registration, read as the host reads it. */
  readonly app: AppManifest;
  /** Each function's contract fingerprint, by path. */
  readonly fingerprints: Readonly<Record<string, string>>;
  /** The App's code, as modules by flat name. */
  readonly modules: Readonly<Record<string, string>>;
  /**
   * The SDK's modules it was inspected with, by flat name, sealed with it
   * (`sdk/` artifacts): what it runs with, whatever SDK the host has now.
   */
  readonly sdk: Readonly<Record<string, string>>;
  /** The store it reads and writes, if it declares tables. */
  readonly store: DataStoreBinding | null;
}

/** `contracts.json` as the host reads it back. */
const contractsSchema = z.strictObject({
  formatVersion: z.literal(contractsFormatVersion),
  resourceId: z.string(),
  resourceVersion: z.int(),
  manifest: z.unknown(),
  fingerprints: z.record(z.string(), z.string()),
});

/** Releases loaded and verified, by manifest hash: their content never changes. */
const verified = new Map<string, Promise<Omit<Release, "manifestHash">>>();

/** How many verified releases one isolate keeps. */
const verifiedMax = 32;

/** The bytes of the artifact `entry` names, checked against its hash and size. */
const artifactText = async (
  env: Env,
  entry: ReleaseArtifact
): Promise<string> => {
  const object = await env.FILES.get(artifactKey(entry.sha256));
  const bytes = object === null ? undefined : await object.arrayBuffer();
  if (
    bytes === undefined ||
    bytes.byteLength !== entry.bytes ||
    (await sha256Of(bytes)) !== entry.sha256
  ) {
    log.error("release.artifact_corrupt", {
      path: entry.path,
      sha256: entry.sha256,
    });
    throw versionErrors.create("version.artifact_corrupt", {
      path: entry.path,
    });
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    bytes
  );
};

/** Where a release's sealed SDK modules are among its artifacts. */
const sdkArtifactDir = "sdk/";

/** A manifest's whole release, every artifact read back and checked. */
const verifiedRelease = async (
  env: Env,
  manifest: ReleaseManifest
): Promise<Omit<Release, "manifestHash">> => {
  const texts = new Map<string, string>();
  for (const entry of manifest.artifacts) {
    // One after the other: a release has a few dozen, and a failure stops
    // the rest.
    // oxlint-disable-next-line no-await-in-loop -- see above
    texts.set(entry.path, await artifactText(env, entry));
  }
  const contractsText = texts.get(generatedPaths.contracts);
  if (
    contractsText === undefined ||
    (await sha256Hex(contractsText)) !== manifest.contractHash
  ) {
    throw versionErrors.create("version.artifact_corrupt", {
      path: generatedPaths.contracts,
    });
  }
  let app: AppManifest;
  let fingerprints: Record<string, string>;
  try {
    const contracts = contractsSchema.parse(JSON.parse(contractsText));
    app = readAppManifest(JSON.stringify(contracts.manifest));
    ({ fingerprints } = contracts);
    if (
      contracts.resourceId !== manifest.resourceId ||
      contracts.resourceVersion !== manifest.resourceVersion ||
      canonicalText(await contractFingerprints(app)) !==
        canonicalText(fingerprints) ||
      (await schemaHash(app.schema)) !== manifest.schemaHash
    ) {
      throw new Error("The contracts don't match their release");
    }
  } catch (error) {
    log.error("release.contracts_corrupt", errorFields(error));
    throw versionErrors.create("version.artifact_corrupt", {
      path: generatedPaths.contracts,
    });
  }
  const [store = null] = manifest.dataStoreBindings;
  const modules: Record<string, string> = {};
  const sdk: Record<string, string> = {};
  for (const [path, text] of texts) {
    if (path.startsWith("modules/")) {
      modules[path.slice("modules/".length)] = text;
    } else if (path.startsWith(sdkArtifactDir)) {
      sdk[path.slice(sdkArtifactDir.length)] = text;
    }
  }
  // Shared by every load of the release in this isolate: frozen, so no
  // caller changes what another runs.
  return deepFreeze({ manifest, app, fingerprints, modules, sdk, store });
};

/**
 * The manifest in `text`, the release of `key`'s: canonical, of the known
 * shape, and naming that release; `version.manifest_corrupt` otherwise.
 */
const manifestOf = (
  text: string,
  key: { app: AppId; version: number }
): ReleaseManifest => {
  let manifest: ReleaseManifest;
  try {
    manifest = releaseManifestSchema.parse(JSON.parse(text));
  } catch {
    throw versionErrors.create("version.manifest_corrupt");
  }
  if (
    manifest.resourceId !== key.app ||
    manifest.resourceVersion !== key.version ||
    canonicalText(manifest) !== text
  ) {
    throw versionErrors.create("version.manifest_corrupt");
  }
  return manifest;
};

/** Whether the host's record of the store binding is the manifest's. */
const bindingAgrees = (
  manifest: ReleaseManifest,
  binding: { targetId: string; schemaHash: string } | undefined
): boolean => {
  const [store] = manifest.dataStoreBindings;
  if (store === undefined || binding === undefined) {
    return store === undefined && binding === undefined;
  }
  return (
    binding.targetId === store.storeId &&
    binding.schemaHash === store.schemaHash
  );
};

/**
 * The sealed release of `app`'s `version`, verified: its manifest's text
 * against its hash, then every artifact's bytes against theirs, the
 * contracts against the manifest's contract hash and the registration
 * read again as the host reads it. `version.not_sealed` for a version
 * never sealed; `version.manifest_corrupt` or `version.artifact_corrupt`
 * for one that no longer matches what was sealed. With `pinned`, the
 * manifest hash an invocation was admitted under, a release whose hash
 * is another is refused too.
 */
export const loadRelease = async (
  env: Env,
  app: AppId,
  version: number,
  pinned?: string
): Promise<Release> => {
  const db = drizzle(env.DB);
  const [row, binding] = await Promise.all([
    db
      .select({
        manifest: sdkReleaseManifests.manifest,
        hash: sdkReleaseManifests.manifestHash,
        revokedAt: sdkReleaseManifests.revokedAt,
      })
      .from(sdkReleaseManifests)
      .where(
        and(
          eq(sdkReleaseManifests.appId, app),
          eq(sdkReleaseManifests.version, version)
        )
      )
      .get(),
    db
      .select({
        targetId: sdkResourceBindings.targetId,
        schemaHash: sdkResourceBindings.schemaHash,
        manifestHash: sdkResourceBindings.manifestHash,
      })
      .from(sdkResourceBindings)
      .where(
        and(
          eq(sdkResourceBindings.resourceId, app),
          eq(sdkResourceBindings.resourceVersion, version),
          eq(sdkResourceBindings.alias, "default")
        )
      )
      .get(),
  ]);
  if (row === undefined) {
    throw versionErrors.create("version.not_sealed");
  }
  // Revoked: it runs no more, whatever else holds (its bytes stay).
  if (row.revokedAt !== null) {
    throw versionErrors.create("version.revoked");
  }
  const hash = await sha256Hex(row.manifest);
  if (
    hash !== row.hash ||
    (pinned !== undefined && pinned !== hash) ||
    (binding !== undefined && binding.manifestHash !== hash)
  ) {
    log.error("release.manifest_corrupt", { app, version });
    throw versionErrors.create("version.manifest_corrupt");
  }
  const manifest = manifestOf(row.manifest, { app, version });
  // The host's own record of the binding and the manifest's must agree:
  // neither alone routes a call. Checked on every load, as the record is
  // read on every load.
  if (!bindingAgrees(manifest, binding)) {
    log.error("release.binding_mismatch", { app, version });
    throw versionErrors.create("version.manifest_corrupt");
  }
  let loading = verified.get(hash);
  if (loading === undefined) {
    loading = verifiedRelease(env, manifest);
    verified.set(hash, loading);
    if (verified.size > verifiedMax) {
      const [oldest] = verified.keys();
      if (oldest !== undefined) {
        verified.delete(oldest);
      }
    }
  }
  try {
    return { ...(await loading), manifestHash: hash };
  } catch (error) {
    verified.delete(hash);
    throw error;
  }
};

/** How often, and how long, a seal waits for a deletion in flight. */
const reserveWait = { attempts: 50, ms: 200 };

/**
 * Reserves `hashes` for release `key` (release-retention.ts), so no sweep
 * deletes their bytes once this release names them; a reservation made
 * again is renewed, so a seal retried long after a failed one isn't swept
 * as an orphan while it runs. Where a deletion of one is in flight, the
 * seal waits for its owner to finish it (the seal stores the bytes after
 * this, so they outlive that deletion); a deletion whose owner stopped
 * (`markTakeoverMs`) is taken over and finished here.
 * `version.seal_busy` if a deletion is still in flight after the wait.
 */
const reserveArtifacts = async (
  env: Env,
  key: { app: AppId; version: number },
  hashes: readonly string[]
): Promise<void> => {
  const unique = [...new Set(hashes)];
  for (let attempt = 1; attempt <= reserveWait.attempts; attempt += 1) {
    const now = Date.now();
    // One batch, one transaction: each reserved only where no deletion
    // mark is.
    // oxlint-disable-next-line no-await-in-loop -- tried again in turn
    await env.DB.batch(
      unique.map((sha256) =>
        env.DB.prepare(
          `INSERT INTO sdk_release_artifacts (sha256, app_id, version, reserved_at)
           SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM sdk_artifact_deletions WHERE sha256 = ?1)
           ON CONFLICT (sha256, app_id, version) DO UPDATE SET reserved_at = excluded.reserved_at`
        ).bind(sha256, key.app, key.version, now)
      )
    );
    // oxlint-disable-next-line no-await-in-loop -- see above
    const marked = await drizzle(env.DB)
      .select({ sha256: sdkArtifactDeletions.sha256 })
      .from(sdkArtifactDeletions)
      .where(inArray(sdkArtifactDeletions.sha256, unique));
    if (marked.length === 0) {
      return;
    }
    for (const { sha256 } of marked) {
      // Only a mark whose owner stopped is taken over; a live one is
      // its owner's to finish.
      // oxlint-disable-next-line no-await-in-loop -- see above
      const owner = await markArtifact(env, sha256, new Date(now));
      if (owner !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- see above
        await finishDeletion(env, sha256, owner);
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- see above
    await scheduler.wait(reserveWait.ms);
  }
  throw versionErrors.create("version.seal_busy");
};

/**
 * Refuses (`version.seal_conflict`) a seal of a version sealed before and
 * deleted since unless it makes the same manifest (`hash`): a version's
 * number never comes to name other code.
 */
const requireAsTombstoned = async (
  env: Env,
  key: { app: AppId; version: number },
  hash: string
): Promise<void> => {
  const tombstone = await drizzle(env.DB)
    .select({ hash: sdkReleaseTombstones.manifestHash })
    .from(sdkReleaseTombstones)
    .where(
      and(
        eq(sdkReleaseTombstones.appId, key.app),
        eq(sdkReleaseTombstones.version, key.version)
      )
    )
    .get();
  if (tombstone !== undefined && tombstone.hash !== hash) {
    throw versionErrors.create("version.seal_conflict");
  }
};

/** The empty dependency lock: server code imports no packages. */
const emptyLock = "{}";

/**
 * Claims `store` for `app` for good (`sdk_store_owners`), or refuses
 * (`version.store_bound_elsewhere`) a store another App claimed: one
 * statement claims it only where no claim exists, so of two Apps sealing
 * onto a new store at once, exactly one gets it.
 */
const claimStore = async (
  env: Env,
  store: StoreId,
  app: AppId
): Promise<void> => {
  const db = drizzle(env.DB);
  await db
    .insert(sdkStoreOwners)
    .values({ storeId: store, appId: app, claimedAt: new Date() })
    .onConflictDoNothing();
  const owner = await db
    .select({ app: sdkStoreOwners.appId })
    .from(sdkStoreOwners)
    .where(eq(sdkStoreOwners.storeId, store))
    .get();
  if (owner?.app !== app) {
    throw versionErrors.create("version.store_bound_elsewhere");
  }
};

/** The App's schema has tables, so it needs a store. */
const hasTables = (app: AppManifest): boolean =>
  Object.keys(app.schema.tables).length > 0;

/** The SHA-256 of the canonical text of the App's functions. */
const operationManifestHash = async (app: AppManifest): Promise<string> =>
  await sha256Hex(canonicalText(app.operations));

/**
 * Seals the release of `request.app`'s `request.version` (see the header)
 * and answers it. A version sealed
 * already answers its release as sealed, whatever store is asked for now;
 * a seal racing another with a different manifest is refused
 * (`version.seal_conflict`).
 */
export const sealRelease = async (
  env: Env,
  request: SealRequest
): Promise<Release> => {
  const { app, version } = request;
  const sealed = await drizzle(env.DB)
    .select({ hash: sdkReleaseManifests.manifestHash })
    .from(sdkReleaseManifests)
    .where(
      and(
        eq(sdkReleaseManifests.appId, app),
        eq(sdkReleaseManifests.version, version)
      )
    )
    .get();
  if (sealed !== undefined) {
    return await loadRelease(env, app, version);
  }
  const row = await findVersion(env, app, version);
  const files = await versionFiles(env, app, version);
  if (!isAppLayout(files)) {
    throw versionErrors.create("version.unsealable");
  }

  // The SDK read once: the modules both inspections run with are the
  // modules sealed with the release, and what it runs with.
  const sdk = await sdkModules(env.ASSETS);

  // The first inspection: symbolic references, resolved against the
  // registration they come with.
  const symbolic = await builtCode(env, {
    ...files,
    ...symbolicModules(),
    [generatedPaths.server]: serverModuleSource,
  });
  const firstText = await inspected(env, symbolic, sdk.modules);
  const manifest = readManifest(firstText);

  // The real modules, then the same code again with them.
  const generated = await generateModules(manifest, {
    resourceId: app,
    resourceVersion: version,
  });
  const final = await builtCode(env, { ...files, ...generated });
  const secondText = await inspected(env, final, sdk.modules);
  const reread = readManifest(secondText);
  if (canonicalText(reread) !== canonicalText(manifest)) {
    throw versionErrors.create("version.unstable_manifest");
  }

  const schema = await schemaHash(manifest.schema);
  let store: DataStoreBinding | null = null;
  if (hasTables(manifest)) {
    if (request.store === undefined) {
      throw versionErrors.create("version.store_unbound");
    }
    // Claimed before its tables are touched, so a seal that loses the
    // store never defines its tables there.
    await claimStore(env, request.store, app);
    const opened = await openStore(env, request.store);
    const defined = await opened.defineTables(manifestText(manifest.schema));
    if (defined.schemaHash !== schema) {
      throw new Error("The store defined another schema than the App's");
    }
    store = {
      alias: "default",
      storeId: opened.id,
      schemaVersion: manifestVersion,
      schemaHash: schema,
      operationManifestHash: await operationManifestHash(manifest),
    };
  }

  const contracts = generated[generatedPaths.contracts] ?? "";
  const report = canonicalText({
    formatVersion: releaseFormatVersion,
    compilerVersion,
    inspections: {
      symbolic: await sha256Hex(canonicalText(manifest)),
      final: await sha256Hex(canonicalText(reread)),
    },
    equal: true,
    modules: Object.keys(final).length,
  });
  const artifacts = await Promise.all([
    ...Object.entries(final).map(
      async ([name, code]) => await artifactOf(`modules/${name}`, code)
    ),
    ...Object.entries(generated).map(
      async ([path, text]) => await artifactOf(path, text)
    ),
    ...Object.entries(sdk.modules).map(
      async ([name, code]) => await artifactOf(`${sdkArtifactDir}${name}`, code)
    ),
    artifactOf(".grasp/verification.json", report),
  ]);
  artifacts.sort((a, b) => (a.entry.path < b.entry.path ? -1 : 1));
  const reportEntry = artifacts.find(
    ({ entry }) => entry.path === ".grasp/verification.json"
  );

  const kit = await kitModules(env.ASSETS);
  const releaseManifest: ReleaseManifest = releaseManifestSchema.parse({
    formatVersion: releaseFormatVersion,
    resourceId: app,
    resourceVersion: version,
    sourceTreeHash: row.tree,
    schemaHash: schema,
    contractHash: await sha256Hex(contracts),
    sdkVersion: sdk.version,
    sdkProtocolVersion,
    uiVersion: kit.version,
    compilerVersion,
    dependencyLockHash: await sha256Hex(emptyLock),
    target: "app",
    dataStoreBindings: store === null ? [] : [store],
    artifacts: artifacts.map(({ entry }) => entry),
    bindings: [],
    verificationReportHash: reportEntry?.entry.sha256,
    artifactTrust: "unreviewed",
  });
  const text = canonicalText(releaseManifest);
  const hash = await sha256Hex(text);
  await requireAsTombstoned(env, { app, version }, hash);

  // Reserved first, so no retention sweep deletes bytes this release will
  // name (release-retention.ts); then the bytes, each under its hash, so a
  // manifest never names a missing artifact. Storing the same bytes again
  // changes nothing.
  await reserveArtifacts(
    env,
    { app, version },
    artifacts.map(({ entry }) => entry.sha256)
  );
  await Promise.all(
    artifacts.map(async ({ entry, bytes }) => {
      // The very bytes hashed, so what is stored is what the hash names.
      await env.FILES.put(artifactKey(entry.sha256), bytes, {
        sha256: entry.sha256,
      });
    })
  );

  const db = drizzle(env.DB);
  try {
    await auditedBatch(env, db, [
      db.insert(sdkReleaseManifests).values({
        appId: app,
        version,
        manifestHash: hash,
        manifest: text,
        sealedAt: new Date(),
      }),
      ...(store === null
        ? []
        : [
            // The target only while this App owns the store: otherwise
            // NULL, which the column refuses, and the whole seal with it.
            db.insert(sdkResourceBindings).values({
              resourceId: app,
              resourceVersion: version,
              alias: store.alias,
              kind: "store" as const,
              targetId: sql`(SELECT ${store.storeId} WHERE EXISTS (SELECT 1 FROM sdk_store_owners
                WHERE store_id = ${store.storeId} AND app_id = ${app}))`,
              schemaHash: store.schemaHash,
              manifestHash: hash,
            }),
          ]),
      outboxed(db, {
        actor: request.by.actor ?? actorOf(request.by),
        action: "app.release.sealed",
        target: { type: "app", id: app },
        detail: {
          version,
          manifestHash: hash,
          contractHash: releaseManifest.contractHash,
          schemaHash: schema,
          ...(store === null ? {} : { store: store.storeId }),
        },
      }),
    ]);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes(
        "NOT NULL constraint failed: sdk_resource_bindings.target_id"
      )
    ) {
      throw versionErrors.create("version.store_bound_elsewhere");
    }
    if (!isUniqueViolation(error)) {
      throw error;
    }
    // Another seal of the version won: the same manifest is this one.
    const won = await loadRelease(env, app, version);
    if (won.manifestHash !== hash) {
      throw versionErrors.create("version.seal_conflict");
    }
    return won;
  }
  // What was just built and stored, as it was verified here: the next load
  // reads it all back from storage.
  return deepFreeze({
    manifest: releaseManifest,
    manifestHash: hash,
    app: manifest,
    fingerprints: await contractFingerprints(manifest),
    modules: { ...final },
    sdk: { ...sdk.modules },
    store,
  });
};
