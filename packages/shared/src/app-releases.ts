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

/** The format of `ReleaseManifest`. */
export const releaseFormatVersion = 1;

/** The version of the protocol between the host and an App's isolate. */
export const sdkProtocolVersion = 1;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

/** One artifact of a release: its path, and its bytes by their hash. */
export const releaseArtifactSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[\w.~-]+(?:\/[\w.~-]+)*$/u),
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
  artifacts: z.array(releaseArtifactSchema).min(1).max(1024),
  bindings: z.array(resourceBindingSchema).max(64),
  verificationReportHash: sha256Schema,
  // Always `unreviewed` as sealed: trust is never the manifest's to say
  // (approval and revocation are the host's records of its hash).
  artifactTrust: z.literal("unreviewed"),
});

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;
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
  "version.manifest_corrupt":
    "This version's sealed manifest no longer matches its hash.",
  "version.artifact_corrupt":
    "One of this version's sealed artifacts no longer matches its hash.",
  "version.revoked": "This version was revoked and no longer runs.",
  "version.mismatch":
    "That reference belongs to another version or contract than the one that runs.",
});
