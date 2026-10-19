import {
  compilerVersion,
  isAppLayout,
  kitModules,
  serverSdkModules,
} from "@grasp-os/compiler";
import {
  contractFingerprints,
  contractsFormatVersion,
  generatedPaths,
  generateModules,
  readSealedWorkflows,
  manifestText,
  manifestVersion,
  readAppManifest,
  schemaHash,
  serverModuleSource,
  symbolicModules,
} from "@grasp-os/sdk/host";
import type { AppManifest, WorkflowBindingExtras } from "@grasp-os/sdk/host";
import {
  checkEvidencePath,
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
import { sha256Hex, sha256HexOfBytes } from "@grasp-os/shared/encoding";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { AppId, StoreId } from "@grasp-os/shared/ids";
import { canonicalText } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { sharedRun } from "@grasp-os/shared/shared-runs";
import type { SharedRun } from "@grasp-os/shared/shared-runs";
import { dataErrors, migrationErrors } from "@grasp-os/shared/stores";
import type { AppliedContract } from "@grasp-os/shared/stores";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  builtCode,
  checkedCode,
  filesManifest,
  inspected,
  readManifest,
} from "./app-inspection.ts";
import { appFor, findVersion, versionFiles, versionTree } from "./apps.ts";
import { auditedBatch, outboxed } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import { boundWorkflowsOf } from "./bound-workflows.ts";
import { checkEvidenceText, evidenceMatches } from "./check-evidence.ts";
import { openStore, requireStoreManager } from "./data-stores.ts";
import {
  appDefaultStores,
  businessStoreVersions,
  sdkArtifactDeletions,
  sdkReleaseArtifacts,
  sdkReleaseManifests,
  sdkReleaseTombstones,
  sdkResourceBindings,
  sdkStoreOwners,
} from "./db/core/schema.ts";
import { inList, isUniqueViolation, notNullFailed } from "./db/d1.ts";
import {
  evidenceFits,
  migrationEvidence,
  requireMigrationsTarget,
} from "./migration-transform.ts";
import { finishDeletion, markArtifact } from "./release-retention.ts";
import { defineSchemaOnStore, schemaStatus } from "./store-backfill.ts";
import { liveStoreSql } from "./store-deletion.ts";

// Sealing an App's release (spec 8, 16): turning one version of an App of
// spec 8's layout into an immutable manifest and the content-addressed
// artifacts it names, which every invocation then runs from. Threat
// model, and how each is closed:
//
// - App code runs while it is inspected: only in Loader isolates with no
//   network, no env and a bound on their time, never in core: the
//   runtime's CPU limit on Cloudflare, a process of their own killed at
//   the deadline on-prem (`callSandboxed`). What they answer is hostile
//   text, read by declaring the App again through the SDK's constructors
//   (`readAppManifest`), which refuses anything no declaration makes.
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
//   the manifest's, each artifact's and the contracts' (`loadRelease`),
//   and the evidence of the seal's checks against the identities and
//   artifacts it names (check-evidence.ts).
//   A new version is a new manifest; a sealed one never changes.
// - A release reaches a store it shouldn't: no App code, request or
//   manifest field names a store. The host that seals binds one, and
//   records the binding apart from the manifest
//   (`sdk_resource_bindings`); loading requires both to agree. A store
//   serves one App for good: the first seal claims it
//   (`sdk_store_owners`) before defining its tables, and retention never
//   deletes the claim.
// - Someone binds a store they don't manage, or one that doesn't exist:
//   the sealer must manage the store and not be Grasp staff, as for
//   sharing it (data-stores.ts), checked before any App code is
//   inspected; and the store must be listed and live before it is
//   claimed, so no claim is ever written for a store that isn't.
// - A release vouches for itself: its trust is always `unreviewed` in the
//   manifest; approval and revocation are the host's records of its hash.
//
// - Someone seals an App they don't build, or binds a store they may not:
//   `sealRelease` checks itself that `by` builds the App, then that they
//   manage the store, unless it is the App's own default store, which the
//   host chose for it (`app_default_stores`, app-activation.ts) and the
//   App's builders bind by their builder rights. Which store to bind is its
//   caller's choice, the host's, never App code's.
// - A load whose request is cancelled mid-read (workerd never settles it)
//   holds every later load of that release in the isolate, or a load that
//   failed or ran on past its time is served as verified: loads of one
//   release share one only for as long as a load may take (`sharedRun`),
//   and only a load that verified every byte keeps its release
//   (`verified`); a failure keeps nothing (`loadRelease`).

/** Where an artifact's bytes are, by their SHA-256. */
export const artifactKey = (sha256: string): string =>
  `release-artifacts/${sha256}`;

const encoder = new TextEncoder();

/** One artifact, as the manifest names it, and the bytes hashed. */
interface Artifact {
  readonly entry: ReleaseArtifact;
  readonly bytes: Uint8Array;
}

/** `text` as the artifact at `path`: its UTF-8 bytes, as stored. */
const artifactOf = async (path: string, text: string): Promise<Artifact> => {
  const bytes = encoder.encode(text);
  return {
    entry: {
      path,
      sha256: await sha256HexOfBytes(bytes),
      bytes: bytes.byteLength,
    },
    bytes,
  };
};

/** `value` with every object and array in it frozen. */
const deepFreeze = <Value>(
  value: Value,
  seen = new WeakSet<object>()
): Value => {
  // Into frozen objects too, whose own entries may not be (as the SDK's
  // does); `seen` only so a shared or cyclic value is walked once.
  if (typeof value === "object" && value !== null && !seen.has(value)) {
    seen.add(value);
    Object.freeze(value);
    for (const entry of Object.values(value)) {
      deepFreeze(entry, seen);
    }
  }
  return value;
};

/** What the host that seals a release gives it. */
interface SealRequest {
  readonly app: AppId;
  readonly version: number;
  /**
   * The store the release reads and writes, which the host chose: needed
   * when the App declares tables, and never anything App code names.
   */
  readonly store?: StoreId;
  /** Who seals it: they must manage `store`, if one is given. */
  readonly by: Acting;
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
  /**
   * What its seal resolved of each workflow it declares (bound-workflows.ts),
   * as its contracts seal it: what its references were generated with,
   * whatever the App's bindings say now.
   */
  readonly workflows: readonly WorkflowBindingExtras[];
}

/** `contracts.json` as the host reads it back. */
const contractsSchema = z.strictObject({
  formatVersion: z.literal(contractsFormatVersion),
  resourceId: z.string(),
  resourceVersion: z.int(),
  manifest: z.unknown(),
  fingerprints: z.record(z.string(), z.string()),
  workflows: z.record(z.string(), z.unknown()),
  workflowFingerprints: z.record(z.string(), z.string()),
});

/** What `contracts` (a release's `contracts.json`) seal of its workflows. */
const sealedWorkflowsOf = (contracts: string): WorkflowBindingExtras[] =>
  readSealedWorkflows(contractsSchema.parse(JSON.parse(contracts)).workflows);

/**
 * Releases loaded and verified, by manifest hash: their content never
 * changes. Only a load that verified every byte against that hash puts
 * one here, so a failed load leaves nothing, and two loads of one hash
 * can only put the same release.
 */
const verified = new Map<string, Omit<Release, "manifestHash">>();

/** How many verified releases one isolate keeps. */
const verifiedMax = 32;

/** Reads an artifact's bytes by their SHA-256: undefined for none. */
export type ArtifactReader = (
  sha256: string
) => Promise<ArrayBuffer | Uint8Array | undefined>;

/** A sealed release's artifacts, as stored: in R2, under their hashes. */
const storedArtifacts =
  (env: Env): ArtifactReader =>
  async (sha256) => {
    const object = await env.FILES.get(artifactKey(sha256));
    return object === null ? undefined : await object.arrayBuffer();
  };

/**
 * The loads running now in this isolate, by manifest hash: loads of a
 * release asked for while one runs share it. A load whose request was
 * cancelled while it read never settles, so it is waited for only as long
 * as a load may take (`sharedRun`, `releaseReadMs`), never until the
 * release is evicted.
 */
const verifying = new Map<string, SharedRun<Omit<Release, "manifestHash">>>();

/**
 * The longest a load of a release takes: its manifest bounds how many
 * artifacts it reads (one R2 read and one hash of each), one after the
 * other, so a base for the first plus a share for each. A real release
 * has a few dozen and loads in well under a second; past this, a load
 * is taken for abandoned and the next to ask reads it anew.
 */
const releaseReadBaseMs = 5000;

/** {@link releaseReadBaseMs}'s share for each artifact a release reads. */
const releaseArtifactReadMs = 100;

/**
 * How long a load of `manifest` may take before it is taken for
 * abandoned, or less where tests set `RELEASE_READ_MS`.
 */
const releaseReadMs = (env: Env, manifest: ReleaseManifest): number => {
  const bound =
    releaseReadBaseMs + manifest.artifacts.length * releaseArtifactReadMs;
  const set = Number(env.RELEASE_READ_MS);
  return Number.isInteger(set) && set > 0 && set < bound ? set : bound;
};

/** The bytes of the artifact `entry` names, checked against its hash and size. */
const artifactText = async (
  read: ArtifactReader,
  entry: ReleaseArtifact
): Promise<string> => {
  const bytes = await read(entry.sha256);
  if (
    bytes === undefined ||
    bytes.byteLength !== entry.bytes ||
    (await sha256HexOfBytes(bytes)) !== entry.sha256
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
  read: ArtifactReader,
  manifest: ReleaseManifest
): Promise<Omit<Release, "manifestHash">> => {
  const texts = new Map<string, string>();
  for (const entry of manifest.artifacts) {
    // One after the other: a release has a few dozen, and a failure stops
    // the rest.
    // oxlint-disable-next-line no-await-in-loop -- see above
    texts.set(entry.path, await artifactText(read, entry));
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
  let workflows: WorkflowBindingExtras[];
  try {
    const contracts = contractsSchema.parse(JSON.parse(contractsText));
    app = readAppManifest(JSON.stringify(contracts.manifest));
    ({ fingerprints } = contracts);
    workflows = readSealedWorkflows(contracts.workflows);
    if (
      contracts.resourceId !== manifest.resourceId ||
      contracts.resourceVersion !== manifest.resourceVersion ||
      canonicalText(await contractFingerprints(app)) !==
        canonicalText(fingerprints) ||
      (await schemaHash(app.schema)) !== manifest.schemaHash ||
      !(await evidenceFits(app.migrations, manifest.migrationEvidence))
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
  // The check's evidence, under the hash the manifest names, recorded
  // against this release and what it seals (check-evidence.ts).
  const evidenceEntry = manifest.artifacts.find(
    ({ path }) => path === checkEvidencePath
  );
  if (
    evidenceEntry?.sha256 !== manifest.verificationReportHash ||
    !(await evidenceMatches(
      manifest,
      { manifest: app, modules, sdk },
      texts.get(checkEvidencePath) ?? ""
    ))
  ) {
    log.error("release.evidence_corrupt", {
      app: manifest.resourceId,
      version: manifest.resourceVersion,
    });
    throw versionErrors.create("version.artifact_corrupt", {
      path: checkEvidencePath,
    });
  }
  // Shared by every load of the release in this isolate: frozen, so no
  // caller changes what another runs.
  return deepFreeze({
    manifest,
    app,
    fingerprints,
    modules,
    sdk,
    store,
    workflows,
  });
};

/**
 * The manifest in `text`, the release of `key`'s: canonical, of the known
 * shape, and naming that release; `version.format_unsupported` for one
 * sealed in another release format, `version.protocol_unsupported` for
 * one sealed for another protocol, `version.manifest_corrupt` otherwise.
 */
const manifestOf = (
  text: string,
  key: { app: AppId; version: number }
): ReleaseManifest => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw versionErrors.create("version.manifest_corrupt");
  }
  // Its hash checked already: a protocol this platform doesn't run is a
  // release of another platform version, not tampering.
  const field = (name: string): unknown =>
    typeof parsed === "object" && parsed !== null
      ? Reflect.get(parsed, name)
      : undefined;
  const format = field("formatVersion");
  if (typeof format === "number" && format !== releaseFormatVersion) {
    throw versionErrors.create("version.format_unsupported");
  }
  const protocol = field("sdkProtocolVersion");
  if (typeof protocol === "number" && protocol !== sdkProtocolVersion) {
    throw versionErrors.create("version.protocol_unsupported");
  }
  let manifest: ReleaseManifest;
  try {
    manifest = releaseManifestSchema.parse(parsed);
  } catch {
    throw versionErrors.create("version.manifest_corrupt");
  }
  // An App's release, binding one store at most (the one the host chose).
  if (
    manifest.resourceId !== key.app ||
    manifest.resourceVersion !== key.version ||
    manifest.target !== "app" ||
    manifest.dataStoreBindings.length > 1 ||
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
 * The sealed manifest of `app`'s `version` and its hash, its text checked
 * against the hash and the host's record of its store binding, its
 * artifacts not read: `version.not_sealed`, `version.revoked` or
 * `version.manifest_corrupt` as `loadRelease` says.
 */
const checkedManifest = async (
  env: Env,
  app: AppId,
  version: number,
  pinned?: string
): Promise<{ manifest: ReleaseManifest; hash: string }> => {
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
          eq(sdkResourceBindings.kind, "store"),
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
  return { manifest, hash };
};

/**
 * Refuses `app`'s `version` unless it loads as a release (`loadRelease`'s
 * own manifest checks): sealed, not revoked, its manifest intact
 * (`version.not_sealed`, `version.revoked`, `version.manifest_corrupt`).
 * For what names a release to call later, such as a workflow binding's
 * approval: its artifacts are verified when it is loaded to run.
 */
export const requireReleaseLoads = async (
  env: Env,
  app: AppId,
  version: number
): Promise<void> => {
  await checkedManifest(env, app, version);
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
  const { manifest, hash } = await checkedManifest(env, app, version, pinned);
  const kept =
    verified.get(hash) ??
    (await sharedRun(
      verifying,
      hash,
      releaseReadMs(env, manifest),
      async () => {
        const loaded = await verifiedRelease(storedArtifacts(env), manifest);
        // A load that ran on past being taken for abandoned keeps what is
        // there already: the same release, as the hash is the same.
        if (!verified.has(hash)) {
          verified.set(hash, loaded);
          if (verified.size > verifiedMax) {
            const [oldest] = verified.keys();
            if (oldest !== undefined) {
              verified.delete(oldest);
            }
          }
        }
        return loaded;
      }
    ));
  return { ...kept, manifestHash: hash };
};

/** A draft release as its keeper stores it (sealed-previews.ts). */
export interface StoredDraft {
  /** Its manifest's canonical text. */
  readonly manifest: string;
  /** The SHA-256 of that text, as it was sealed. */
  readonly manifestHash: string;
}

/**
 * A draft release (`sealDraftRelease`), verified with `loadRelease`'s own
 * checks: the manifest's text against its hash, canonical, of the known
 * shape and naming `key`, binding no store; then every artifact `read`
 * gives back against its hash and size, and the contracts against the
 * manifest. `version.manifest_corrupt` or `version.artifact_corrupt` for
 * one that no longer matches what was sealed. Its keeper loads it once
 * for each preview it starts, and keeps what loaded while that runs.
 */
export const loadDraftRelease = async (
  key: { app: AppId; version: number },
  stored: StoredDraft,
  read: ArtifactReader
): Promise<Release> => {
  const hash = await sha256Hex(stored.manifest);
  if (hash !== stored.manifestHash) {
    log.error("release.draft_manifest_corrupt", key);
    throw versionErrors.create("version.manifest_corrupt");
  }
  const manifest = manifestOf(stored.manifest, key);
  // A draft is never bound to a store: its preview's store is the host's
  // to hand each invocation, and no other.
  if (manifest.dataStoreBindings.length > 0) {
    log.error("release.draft_binds_store", key);
    throw versionErrors.create("version.manifest_corrupt");
  }
  // Every load reads every artifact back and checks it: no cache between
  // loads, so what a keeper loads again is always what it keeps now.
  return { ...(await verifiedRelease(read, manifest)), manifestHash: hash };
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
 * `key.app` is the release's resource: an App, or an independent workflow
 * whose version seals its build (workflow-builds.ts).
 */
export const reserveArtifacts = async (
  env: Env,
  key: { app: string; version: number },
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
    // Done only once every hash is reserved for this release: a hash the
    // batch skipped for a mark whose owner finished it just after is
    // simply tried again.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const reserved = await drizzle(env.DB)
      .select({ sha256: sdkReleaseArtifacts.sha256 })
      .from(sdkReleaseArtifacts)
      .where(
        and(
          eq(sdkReleaseArtifacts.appId, key.app),
          eq(sdkReleaseArtifacts.version, key.version),
          inList(sdkReleaseArtifacts.sha256, unique)
        )
      );
    const have = new Set(reserved.map(({ sha256 }) => sha256));
    const missing = unique.filter((sha256) => !have.has(sha256));
    if (missing.length === 0) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- see above
    const marked = await drizzle(env.DB)
      .select({ sha256: sdkArtifactDeletions.sha256 })
      .from(sdkArtifactDeletions)
      .where(inList(sdkArtifactDeletions.sha256, missing));
    if (marked.length === 0) {
      // Unmarked since the batch: reserved on the next try, at once.
      continue;
    }
    for (const { sha256 } of marked) {
      // Only a mark whose owner stopped is taken over; a live one is
      // its owner's to finish.
      // oxlint-disable-next-line no-await-in-loop -- see above
      const owner = await markArtifact(env, sha256);
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

/** Whether `store` is App `app`'s own default store, as the host records it. */
const isDefaultStore = async (
  env: Env,
  app: AppId,
  store: StoreId
): Promise<boolean> => {
  const row = await drizzle(env.DB)
    .select({ store: appDefaultStores.storeId })
    .from(appDefaultStores)
    .where(
      and(eq(appDefaultStores.appId, app), eq(appDefaultStores.storeId, store))
    )
    .get();
  return row !== undefined;
};

/** Whether `store` is claimed for `app` (`sdk_store_owners`). */
const claimedBy = async (
  env: Env,
  store: string | undefined,
  app: AppId
): Promise<boolean> => {
  if (store === undefined) {
    return false;
  }
  const row = await drizzle(env.DB)
    .select({ app: sdkStoreOwners.appId })
    .from(sdkStoreOwners)
    .where(eq(sdkStoreOwners.storeId, store))
    .get();
  return row?.app === app;
};

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

/** Whether `version` of `app` has a sealed release. */
const isSealed = async (
  env: Env,
  app: AppId,
  version: number
): Promise<boolean> =>
  (await drizzle(env.DB)
    .select({ version: sdkReleaseManifests.version })
    .from(sdkReleaseManifests)
    .where(
      and(
        eq(sdkReleaseManifests.appId, app),
        eq(sdkReleaseManifests.version, version)
      )
    )
    .get()) !== undefined;

/**
 * The App manifest of `version` of `app`, as the host reads it: its
 * sealed release's when it has one, otherwise its code built and
 * inspected in the sandbox as a seal's first inspection does (symbolic
 * references, nothing stored). Undefined for a version not of spec 8's
 * layout. Throws as a seal would for code that doesn't build or inspect.
 */
export const versionManifest = async (
  env: Env,
  app: AppId,
  version: number,
  files: Readonly<Record<string, string>>
): Promise<AppManifest | undefined> => {
  if (!isAppLayout(files)) {
    return undefined;
  }
  if (await isSealed(env, app, version)) {
    const release = await loadRelease(env, app, version);
    return release.app;
  }
  return await filesManifest(env, files, app);
};

/**
 * What `version` of `app`'s references are generated from: its sealed
 * release's manifest and what its seal resolved of its workflows when it
 * has one, so its screens get the very bytes the release sealed; otherwise
 * its inspected manifest and the workflows as the App binds them now, as a
 * seal would. Undefined for a version not of spec 8's layout. Throws as
 * {@link versionManifest} does.
 */
export const versionReferenceSource = async (
  env: Env,
  app: AppId,
  version: number,
  files: Readonly<Record<string, string>>
): Promise<
  | { manifest: AppManifest; workflows: readonly WorkflowBindingExtras[] }
  | undefined
> => {
  if (!isAppLayout(files)) {
    return undefined;
  }
  if (await isSealed(env, app, version)) {
    const release = await loadRelease(env, app, version);
    return { manifest: release.app, workflows: release.workflows };
  }
  const manifest = await filesManifest(env, files, app);
  return { manifest, workflows: await boundWorkflowsOf(env, app, manifest) };
};

/**
 * What running `version`'s migrations on their fixtures found as it was
 * sealed (`ReleaseManifest.migrationEvidence`); undefined while it isn't
 * sealed. Read from its manifest alone, checked against its hash: its
 * artifacts aren't loaded, so asking leaves no verified release cached
 * for its first run to take (`loadRelease` checks every byte then).
 */
export const sealedEvidence = async (
  env: Env,
  app: AppId,
  version: number
): Promise<ReleaseManifest["migrationEvidence"] | undefined> => {
  const sealed = await drizzle(env.DB)
    .select({ version: sdkReleaseManifests.version })
    .from(sdkReleaseManifests)
    .where(
      and(
        eq(sdkReleaseManifests.appId, app),
        eq(sdkReleaseManifests.version, version)
      )
    )
    .get();
  if (sealed === undefined) {
    return undefined;
  }
  const { manifest } = await checkedManifest(env, app, version);
  return manifest.migrationEvidence;
};

/**
 * The store release `request` binds, with the App's schema (`schema`, its
 * hash) applied to it for this version, and what that did to the store's
 * contract; or null for an App without tables; `version.store_unbound`
 * for one with tables and no store. The store applies the schema only
 * when the change to its contract is safe (store-host.ts,
 * `defineTables`), and refuses one that needs a migration
 * (`migration.required`), so no release is sealed on a store whose data
 * its schema doesn't fit. A schema whose defaulted fields the store's
 * records lack is taken as the store's pending target: the release is
 * sealed, and runs only once the store has filled them in
 * (store-backfill.ts). A seal that fails after the store applied the
 * schema leaves it applied: a retry finds it so, and its receipt.
 */
const boundStore = async (
  env: Env,
  request: SealRequest,
  manifest: AppManifest,
  schema: string
): Promise<{ binding: DataStoreBinding; contract: AppliedContract } | null> => {
  if (!hasTables(manifest)) {
    return null;
  }
  if (request.store === undefined) {
    throw versionErrors.create("version.store_unbound");
  }
  // Listed and live first, then claimed before its tables are touched,
  // so a seal that loses the store never defines its tables there, and
  // no claim is ever written for a store that doesn't exist.
  const opened = await openStore(env, request.store);
  await claimStore(env, opened.id, request.app);
  const defined = await defineSchemaOnStore(
    env,
    opened,
    manifestText(manifest.schema),
    { resourceId: request.app, resourceVersion: request.version },
    Object.values(manifest.migrations).map(
      ({ name, table, fromSchema, toSchema }) => ({
        name,
        table,
        fromSchema,
        toSchema,
      })
    )
  );
  if (defined.schemaHash !== schema) {
    throw new Error("The store defined another schema than the App's");
  }
  return {
    binding: {
      alias: "default",
      storeId: opened.id,
      schemaVersion: manifestVersion,
      schemaHash: schema,
      operationManifestHash: await operationManifestHash(manifest),
    },
    contract: defined.contract,
  };
};

/**
 * A release sealed already: its artifacts reserved again before it is
 * answered, so sealing a version always leaves its release protected,
 * whatever happened to its reservations; then loaded, every byte checked.
 * Its store's definition was recorded with its seal, in the same write.
 * One whose store abandoned the target its schema waited on is refused
 * (`migration.abandoned`), as a fresh seal of it would be: its store
 * keeps that per release (store-abandon.ts), so this holds even once a
 * later release brought the same schema back into force.
 */
const resealed = async (
  env: Env,
  { app, version }: { app: AppId; version: number },
  sealedManifest: string
): Promise<Release> => {
  const named = manifestOf(sealedManifest, { app, version });
  await reserveArtifacts(
    env,
    { app, version },
    named.artifacts.map(({ sha256 }) => sha256)
  );
  const release = await loadRelease(env, app, version);
  if (release.store !== null) {
    const status = await schemaStatus(
      env,
      storeIdSchema.parse(release.store.storeId),
      release.store.schemaHash,
      { resourceId: app, resourceVersion: version }
    );
    if (status.state === "abandoned") {
      throw migrationErrors.create("migration.abandoned");
    }
  }
  return release;
};

/**
 * What the store recorded of applying a release's schema, its receipt
 * included, for the seal's audit entry: evidence from the store itself,
 * beside the release. Nothing for a release without a store.
 */
const storeEvidence = (
  bound: Awaited<ReturnType<typeof boundStore>>
): Record<string, string | boolean | null> =>
  bound === null
    ? {}
    : {
        store: bound.binding.storeId,
        storeContractHash: bound.contract.hash,
        storePlanHash: bound.contract.planHash,
        storeContractChanged: bound.contract.changed,
        storeContractPending: bound.contract.pending,
        storeReceipt: bound.contract.receiptId,
      };

/** What sealing makes of an App's files, before the host binds or stores any of it. */
interface InspectedRelease {
  /** The registration, read the same by both inspections. */
  readonly manifest: AppManifest;
  /** The modules generated from it, with the release's identity. */
  readonly generated: Readonly<Record<string, string>>;
  /** The App's code, built with the generated modules. */
  readonly final: Readonly<Record<string, string>>;
  /** The SDK it was inspected with, sealed with it. */
  readonly sdk: {
    readonly version: string;
    readonly modules: Record<string, string>;
  };
  readonly schema: string;
  readonly evidence: ReleaseManifest["migrationEvidence"];
  /** What each inspection answered, recorded in the check's evidence. */
  readonly inspections: { readonly symbolic: string; readonly final: string };
}

/**
 * `files`, an App's code for release `key`, built and inspected as a seal
 * does (see the header): twice, the second time with the modules
 * generated from the first, and refused unless both read the same; then
 * each explicit migration run on its fixtures. `version.unsealable` for
 * files not of spec 8's layout.
 */
const inspectForSeal = async (
  env: Env,
  key: { app: AppId; version: number },
  files: Readonly<Record<string, string>>
): Promise<InspectedRelease> => {
  if (!isAppLayout(files)) {
    throw versionErrors.create("version.unsealable");
  }
  // The SDK read once: the modules both inspections run with are the
  // modules sealed with the release, and what it runs with.
  const sdk = await serverSdkModules(env.ASSETS);

  // The first inspection: symbolic references, resolved against the
  // registration they come with.
  const symbolic = await builtCode(
    env,
    {
      ...files,
      ...symbolicModules(),
      [generatedPaths.server]: serverModuleSource,
    },
    key.app
  );
  const firstText = await inspected(env, symbolic, sdk.modules);
  const manifest = readManifest(firstText);

  // The real modules, then the same code again with them: the workflows
  // it declares as the App binds them now, sealed with it.
  const generated = await generateModules(
    manifest,
    { resourceId: key.app, resourceVersion: key.version },
    await boundWorkflowsOf(env, key.app, manifest)
  );
  // Type-checked with them, against the SDK's server side: nothing is
  // sealed that doesn't check.
  const final = await checkedCode(env, { ...files, ...generated }, key.app);
  const secondText = await inspected(env, final, sdk.modules);
  const reread = readManifest(secondText);
  if (canonicalText(reread) !== canonicalText(manifest)) {
    throw versionErrors.create("version.unstable_manifest");
  }

  const schema = await schemaHash(manifest.schema);
  requireMigrationsTarget(manifest.migrations, schema);
  // Each explicit migration run on its fixtures, the release's own code in
  // the sandbox, before the store is handed it: what the host found is
  // sealed into the manifest, passed or failed, and only a passed
  // migration runs on records or is made current (migration-evidence.ts).
  const evidence = await migrationEvidence(env, {
    app: manifest,
    modules: final,
    sdk: sdk.modules,
  });
  return {
    manifest,
    generated,
    final,
    sdk,
    schema,
    evidence,
    inspections: { symbolic: firstText, final: secondText },
  };
};

/** A release as sealed: its artifacts, and its canonical manifest and hash. */
interface PackagedRelease {
  readonly artifacts: readonly Artifact[];
  readonly releaseManifest: ReleaseManifest;
  /** The manifest's canonical text, as stored. */
  readonly text: string;
  /** The SHA-256 of `text`. */
  readonly hash: string;
}

/**
 * The release of `built` for `key`: every artifact under the SHA-256 of
 * its bytes, and the manifest naming them, the source tree `tree` and the
 * store binding `store` the host chose, as canonical text and its hash.
 */
const packaged = async (
  env: Env,
  key: { app: AppId; version: number },
  built: InspectedRelease,
  { tree, store }: { tree: string; store: DataStoreBinding | null }
): Promise<PackagedRelease> => {
  const { manifest, generated, final, sdk, schema, evidence, inspections } =
    built;
  const contracts = generated[generatedPaths.contracts] ?? "";
  const kit = await kitModules(env.ASSETS);
  // What the release is, before what it seals: the check's evidence is
  // recorded against these, and the manifest names its hash.
  const identity = {
    formatVersion: releaseFormatVersion,
    resourceId: key.app,
    resourceVersion: key.version,
    sourceTreeHash: tree,
    schemaHash: schema,
    contractHash: await sha256Hex(contracts),
    sdkVersion: sdk.version,
    sdkProtocolVersion,
    uiVersion: kit.version,
    compilerVersion,
    dependencyLockHash: await sha256Hex(emptyLock),
    target: "app",
    dataStoreBindings: store === null ? [] : [store],
    bindings: [],
    migrationEvidence: evidence,
    artifactTrust: "unreviewed",
  } as const;
  const report = await checkEvidenceText(
    identity,
    { manifest, modules: final, sdk: sdk.modules },
    inspections
  );
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
    artifactOf(checkEvidencePath, report),
  ]);
  artifacts.sort((a, b) => (a.entry.path < b.entry.path ? -1 : 1));
  const reportEntry = artifacts.find(
    ({ entry }) => entry.path === checkEvidencePath
  );

  const releaseManifest: ReleaseManifest = releaseManifestSchema.parse({
    ...identity,
    artifacts: artifacts.map(({ entry }) => entry),
    verificationReportHash: reportEntry?.entry.sha256,
  });
  const text = canonicalText(releaseManifest);
  return { artifacts, releaseManifest, text, hash: await sha256Hex(text) };
};

/** A draft release, sealed: its manifest, and every artifact's bytes by hash. */
export interface SealedDraft extends StoredDraft {
  readonly artifacts: readonly { sha256: string; bytes: Uint8Array }[];
}

/**
 * Seals `files`, a chat's draft of `key.app`, as the release of the
 * version it would become (`key.version`), exactly as `sealRelease` seals
 * a version (see the header), but bound to no store and stored nowhere:
 * its keeper (sealed-previews.ts) keeps what this answers, and loads it
 * back through `loadDraftRelease`. It names a version no one committed,
 * so nothing that runs a version (`loadRelease`) ever finds it.
 * `version.unsealable` for files not of spec 8's layout.
 */
export const sealDraftRelease = async (
  env: Env,
  key: { app: AppId; version: number },
  files: ReadonlyMap<string, string>
): Promise<SealedDraft> => {
  const { tree } = await versionTree(files);
  const built = await inspectForSeal(env, key, Object.fromEntries(files));
  const { artifacts, text, hash } = await packaged(env, key, built, {
    tree,
    store: null,
  });
  const unique = new Map<string, Uint8Array>();
  for (const { entry, bytes } of artifacts) {
    unique.set(entry.sha256, bytes);
  }
  return {
    manifest: text,
    manifestHash: hash,
    artifacts: [...unique].map(([sha256, bytes]) => ({ sha256, bytes })),
  };
};

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
  // Only the App's builders seal its versions.
  await appFor(env, request.by, app, "builder");
  const sealed = await drizzle(env.DB)
    .select({ manifest: sdkReleaseManifests.manifest })
    .from(sdkReleaseManifests)
    .where(
      and(
        eq(sdkReleaseManifests.appId, app),
        eq(sdkReleaseManifests.version, version)
      )
    )
    .get();
  if (sealed !== undefined) {
    return await resealed(env, { app, version }, sealed.manifest);
  }
  // Before any App code is inspected: the App's own default store, which
  // the host chose for it (`app_default_stores`), is bound by its builder
  // rights; any other store only by someone who manages it, since a
  // binding hands the App's callers its records.
  if (
    request.store !== undefined &&
    !(await isDefaultStore(env, app, request.store))
  ) {
    await requireStoreManager(env, request.by, request.store);
  }
  const row = await findVersion(env, app, version);
  const files = await versionFiles(env, app, version);
  const built = await inspectForSeal(env, { app, version }, files);
  const bound = await boundStore(env, request, built.manifest, built.schema);
  const store = bound?.binding ?? null;
  const { artifacts, releaseManifest, text, hash } = await packaged(
    env,
    { app, version },
    built,
    { tree: row.tree, store }
  );
  const { manifest, final, sdk, schema } = built;
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
        // The hash only while every artifact the manifest names is
        // reserved for this release: otherwise NULL, which the column
        // refuses, and the whole seal with it. Reservations go only with
        // the manifest, so no sweep deletes bytes a sealed release names.
        manifestHash: sql`(SELECT ${hash} WHERE NOT EXISTS (
          SELECT 1 FROM json_each(${text}, '$.artifacts') AS named
          WHERE NOT EXISTS (SELECT 1 FROM sdk_release_artifacts AS reserved
            WHERE reserved.app_id = ${app} AND reserved.version = ${version}
              AND reserved.sha256 = json_extract(named.value, '$.sha256'))))`,
        manifest: text,
        sealedAt: new Date(),
      }),
      ...(store === null
        ? []
        : [
            // The target only while this App owns the store and it is live
            // and not being deleted: otherwise NULL, which the column
            // refuses, and the whole seal with it. So of a seal binding the
            // store and its deletion's closing mark, one wins.
            // The store's definition in core's inventory, numbered as it
            // first appears; the binding below names its version.
            db
              .insert(businessStoreVersions)
              .values({
                storeId: store.storeId,
                version: sql`COALESCE((SELECT MAX(version) FROM business_store_versions
                  WHERE store_id = ${store.storeId}), 0) + 1`,
                schemaHash: store.schemaHash,
                operationManifestHash: store.operationManifestHash,
                sourceTreeHash: row.tree,
                createdAt: new Date(),
              })
              .onConflictDoNothing({
                target: [
                  businessStoreVersions.storeId,
                  businessStoreVersions.schemaHash,
                  businessStoreVersions.operationManifestHash,
                ],
              }),
            db.insert(sdkResourceBindings).values({
              resourceId: app,
              resourceVersion: version,
              alias: store.alias,
              kind: "store" as const,
              targetId: sql`(SELECT ${store.storeId} WHERE EXISTS (SELECT 1 FROM sdk_store_owners
                WHERE store_id = ${store.storeId} AND app_id = ${app})
                AND ${liveStoreSql(sql`${store.storeId}`, Date.now())})`,
              schemaHash: store.schemaHash,
              manifestHash: hash,
              targetVersion: sql`(SELECT version FROM business_store_versions
                WHERE store_id = ${store.storeId} AND schema_hash = ${store.schemaHash}
                  AND operation_manifest_hash = ${store.operationManifestHash})`,
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
          ...storeEvidence(bound),
        },
      }),
    ]);
  } catch (error) {
    if (notNullFailed(error, "sdk_resource_bindings.target_id")) {
      // Another App's, or being deleted (or gone) as the batch ran.
      throw (await claimedBy(env, store?.storeId, app))
        ? dataErrors.create("data.store_unavailable")
        : versionErrors.create("version.store_bound_elsewhere");
    }
    if (notNullFailed(error, "sdk_release_manifests.manifest_hash")) {
      throw versionErrors.create("version.seal_busy");
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
    // As the next load reads them back from the contracts just sealed.
    workflows: sealedWorkflowsOf(
      built.generated[generatedPaths.contracts] ?? ""
    ),
  });
};
