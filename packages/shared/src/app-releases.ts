import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";

// A sealed release of an App (spec 16): the immutable manifest that pins
// everything one version runs with, and the content-addressed artifacts it
// names. Core seals it once per version (apps/core/src/app-releases.ts) and
// every invocation runs from it, never from source again: a source edit
// makes a new version and a new manifest, never a change to a sealed one.
//
// The manifest grants nothing. Its store bindings are routing, its
// resource bindings identify contracts, and whether anyone may use any of
// it is decided against current grants on every call. Its trust is never
// a field its source can set: a sealed manifest always says `unreviewed`,
// and approval or revocation is the host's own record of its hash.

/**
 * The format of `ReleaseManifest` and of the check evidence it names:
 * version 2 records the evidence (`checkEvidenceSchema`) every load
 * verifies. A release sealed in another format is refused as such
 * (`version.format_unsupported`), sealing it again included, since its
 * manifest is stored for good: a new version replaces it, and none is
 * read as this.
 */
export const releaseFormatVersion = 2;

/**
 * The version of the protocol between the host and an App's isolate. The
 * host's half (its run module, app-functions.ts) imports from a release's
 * sealed SDK only what this version pins: version 1 pins the runner's
 * `runFunction` (and `manifestOfApp`, for inspection); version 2 adds
 * `runMigration`, which runs an App's explicit migrations
 * (apps/core/src/migration-transform.ts), and the App manifest's
 * `migrations`. Anything else the host's half needs in the isolate is a
 * host module it loads itself. A new import from the sealed SDK requires
 * a new version, since releases sealed before it don't have it.
 */
export const sdkProtocolVersion = 2;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

/** One artifact of a release: its path, and its bytes by their hash. */
export const releaseArtifactSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(512)
    // Flat module names, `@` included (the SDK's, `sdk/@grasp-os~sdk.js`);
    // no segment can step out of its folder.
    .regex(/^[\w.~@-]+(?:\/[\w.~@-]+)*$/u)
    .refine((path) => !path.split("/").some((part) => /^\.+$/u.test(part)), {
      message: "A path segment can't be dots alone",
    }),
  sha256: sha256Schema,
  bytes: z
    .int()
    .min(0)
    .max(64 * 1024 * 1024),
});

/** A store a release reads and writes, as the host bound it. */
export const dataStoreBindingSchema = z.strictObject({
  alias: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u),
  storeId: z.string().min(1).max(128),
  schemaVersion: z.int().min(1),
  schemaHash: sha256Schema,
  operationManifestHash: sha256Schema,
});

/** A resource a release calls, as an approved binding identifies it. */
export const resourceBindingSchema = z.strictObject({
  alias: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u),
  resourceId: z.string().min(1).max(128),
  resourceVersion: z.int().min(1),
  contractId: z.string().min(1).max(256),
  fingerprint: sha256Schema,
});

/** Why a migration's fixture failed as the host ran it (see below). */
export const migrationFixtureReasons = [
  "invalid_input",
  "threw",
  "invalid_output",
  "too_large",
  "invalid_answer",
  "unexpected_output",
] as const;

/**
 * What the host found running one of a release's explicit migrations on
 * its fixtures as it sealed the release (spec 17.2): the release's own
 * code, in the sandbox, every output validated against the target table
 * and compared with what the fixture expects. The host's own record,
 * sealed into the manifest, so its hash binds it to the source tree, the
 * schemas and the release; nothing App code answers is taken for it. A
 * failure names the fixture (by its index in the migration's `fixtures`,
 * or null when none is to blame) and why; fixtures are the App's own
 * data, never real records. Only a migration whose fixtures all passed
 * runs on records or is made current (apps/core/src/migration-evidence.ts).
 */
export const migrationEvidenceSchema = z
  .strictObject({
    migration: z.string().min(1).max(64),
    table: z.string().min(1).max(64),
    fromSchema: sha256Schema,
    toSchema: sha256Schema,
    /** SHA-256 of the canonical JSON of its fixtures, as the App declares them. */
    fixturesHash: sha256Schema,
    fixtures: z.int().min(1).max(16),
    passed: z.boolean(),
    failure: z
      .strictObject({
        fixture: z.int().min(0).max(15).nullable(),
        reason: z.enum(migrationFixtureReasons),
        issues: z.array(z.string().max(500)).max(20),
      })
      .nullable(),
  })
  .refine(({ passed, failure }) => passed === (failure === null), {
    message: "A migration's evidence fails exactly when it names a failure",
  });

export type MigrationEvidence = z.infer<typeof migrationEvidenceSchema>;

/** A release's manifest (spec 16.1). */
export const releaseManifestSchema = z.strictObject({
  formatVersion: z.literal(releaseFormatVersion),
  resourceId: z.string().min(1).max(128),
  resourceVersion: z.int().min(1),
  sourceTreeHash: sha256Schema,
  schemaHash: sha256Schema,
  contractHash: sha256Schema,
  sdkVersion: z.string().min(1).max(128),
  sdkProtocolVersion: z.literal(sdkProtocolVersion),
  uiVersion: z.string().min(1).max(128),
  compilerVersion: z.string().min(1).max(128),
  dependencyLockHash: sha256Schema,
  target: z.enum(["app", "workflow", "store"]),
  dataStoreBindings: z.array(dataStoreBindingSchema).max(16),
  artifacts: z
    .array(releaseArtifactSchema)
    .min(1)
    .max(1024)
    // One artifact per path: a load keeps one text per path, so a second
    // entry would be verified and then never be what runs.
    .refine(
      (artifacts) =>
        new Set(artifacts.map(({ path }) => path)).size === artifacts.length,
      { message: "Two artifacts can't share a path" }
    ),
  bindings: z.array(resourceBindingSchema).max(64),
  verificationReportHash: sha256Schema,
  /** One per explicit migration the App declares, in its order. */
  migrationEvidence: z.array(migrationEvidenceSchema).max(16),
  // Always `unreviewed` as sealed: trust is never the manifest's to say
  // (approval and revocation are the host's records of its hash).
  artifactTrust: z.literal("unreviewed"),
});

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

/** Where a release's check evidence is among its artifacts. */
export const checkEvidencePath = ".grasp/verification.json";

/**
 * What the host observed checking a release as it sealed it: never a
 * claim of the compiler's or of App code, and never a verdict on its own,
 * only hashes of what the checks read and made, against the identities
 * they were made for. Sealed as an artifact (`checkEvidencePath`) whose
 * hash the manifest names (`verificationReportHash`); loading recomputes
 * every hash it can from the sealed artifacts and refuses the release
 * unless each, and each identity, is the manifest's
 * (apps/core/src/check-evidence.ts). Strict: no field a report adds, such
 * as a trust it claims, is ever read.
 */
export const checkEvidenceSchema = z.strictObject({
  formatVersion: z.literal(releaseFormatVersion),
  /** The source checked. */
  source: z.strictObject({
    resourceId: z.string().min(1).max(128),
    sourceTreeHash: sha256Schema,
  }),
  /** The release it was checked as. */
  candidate: z.strictObject({
    resourceVersion: z.int().min(1),
    contractHash: sha256Schema,
    schemaHash: sha256Schema,
  }),
  /** What it was checked with. */
  profile: z.strictObject({
    target: z.enum(["app", "workflow", "store"]),
    compilerVersion: z.string().min(1).max(128),
    sdkVersion: z.string().min(1).max(128),
    sdkProtocolVersion: z.literal(sdkProtocolVersion),
    uiVersion: z.string().min(1).max(128),
  }),
  /** SHA-256 of what the checks read and made, each canonical JSON but the texts. */
  observed: z.strictObject({
    /** Each inspection's text as the sandbox answered it: not sealed, so not recomputed. */
    symbolicInspection: sha256Schema,
    finalInspection: sha256Schema,
    /** The registration both inspections read. */
    manifest: sha256Schema,
    /** The modules the type check passed, by flat name. */
    checkedModules: sha256Schema,
    /** The SDK modules both inspections ran with, by name. */
    sdkModules: sha256Schema,
    /** What running the explicit migrations on their fixtures found. */
    migrations: sha256Schema,
  }),
});

export type CheckEvidence = z.infer<typeof checkEvidenceSchema>;
export type ReleaseArtifact = z.infer<typeof releaseArtifactSchema>;
export type DataStoreBinding = z.infer<typeof dataStoreBindingSchema>;

/** Why a release couldn't be sealed, loaded or run. */
export const versionErrors = defineErrorFamily({
  "version.unsealable":
    "This version isn't an App of the current layout: it has no app.ts and schema.ts.",
  "version.build_failed": "This version's server code doesn't build.",
  "version.inspection_failed":
    "This version's server code failed while it was inspected.",
  "version.invalid_manifest":
    "This version's registration isn't one the platform accepts.",
  "version.unstable_manifest":
    "This version's registration changed between two inspections of the same code.",
  "version.store_unbound":
    "This version declares tables, but no store is bound for it.",
  "version.store_bound_elsewhere":
    "That store is bound to another App's releases, and serves only that App.",
  "version.seal_busy":
    "Some of this version's artifacts are being deleted. Seal it again in a moment.",
  "version.seal_conflict":
    "This version was already sealed with a different manifest.",
  "version.not_sealed": "This version hasn't been sealed.",
  "version.export_too_large":
    "This App and the workflow versions it binds are more than one export holds.",
  "version.export_secret_found":
    "A file of this App or of a workflow it binds holds what looks like a secret, so it can't be exported. Remove it from that file, publish or seal again, then export.",
  "version.format_unsupported":
    "This version was sealed in a release format this platform doesn't read. Publish a new version and make it current.",
  "version.protocol_unsupported":
    "This version was sealed for a protocol between the platform and App code that this platform doesn't run. Publish a new version and make it current.",
  "version.manifest_corrupt":
    "This version's sealed manifest no longer matches its hash.",
  "version.artifact_corrupt":
    "One of this version's sealed artifacts no longer matches its hash.",
  "version.revoked": "This version was revoked and no longer runs.",
  "version.mismatch":
    "That reference belongs to another version or contract than the one that runs.",
  "version.tests_failed":
    "This version's App tests fail, so it can't be made current.",
  "version.tests_unavailable":
    "This version has App tests, which run only where a sandbox bounds them: on this deployment they need the sandbox host (SANDBOX_HOST bound to the sandbox supervisor). Until it's bound, a version with App tests can't be made current here.",
  "version.invalid_migration":
    "One of this version's migrations doesn't transform records to this version's schema: set its toSchema to the schema hash these details name.",
  "version.migration_fixtures_failed":
    "One of this version's migrations failed on its fixtures as the version was sealed, so it runs on no records and the version can't be made current. These details name the migration, the fixture and why.",
});
