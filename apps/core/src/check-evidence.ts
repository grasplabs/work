import type { AppManifest } from "@grasp-os/sdk/host";
import {
  checkEvidenceSchema,
  releaseFormatVersion,
} from "@grasp-os/shared/app-releases";
import type {
  CheckEvidence,
  ReleaseManifest,
} from "@grasp-os/shared/app-releases";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson, canonicalText } from "@grasp-os/shared/json";

// A release's check evidence (`CheckEvidence`): what the host observed
// checking it as it sealed it, recorded against the identities it names
// and verified against them on every load.
//
// What it protects, and what it doesn't: every field a load compares is
// either the manifest's own or recomputed from artifacts the manifest's
// hash already verified, and the two inspection hashes can't be
// recomputed at all. So its integrity rests on the manifest hash in D1,
// like the rest of the release: someone who can write both D1 and R2
// can forge evidence as they can forge the release. The anchor outside
// that storage is the audit chain: the seal's `app.release.sealed` entry
// records the manifest hash and this evidence's hash
// (`verificationReportHash`). Binding the evidence to something a storage
// writer can't make (a Worker secret, or the audit chain on load) is a
// follow-up. What the check closes:
//
// - A seal records evidence of something other than what it sealed: of
//   other code, another SDK, another registration or other migration
//   evidence than its artifacts and manifest hold, or for another source,
//   release or profile. Loading recomputes what it can from the sealed
//   artifacts, takes each identity from the manifest, and refuses the
//   release unless the report is exactly that evidence.
// - A success report vouches for itself: the evidence holds no verdict,
//   only hashes of what the host's own checks read and made. Nothing the
//   compiler or App code answers is taken for it.
// - A report is missing, or the manifest's report hash names another
//   artifact: loading requires the one artifact at `checkEvidencePath`,
//   under the hash the manifest names.
// - A report claims more than it may, such as trust: the schema is
//   strict and the report is compared whole, as canonical text, with the
//   evidence the host expects; trust is the host's record of the
//   manifest's hash, never the report's.

/** The release identities a check is recorded against: the manifest's own. */
export type CheckedRelease = Pick<
  ReleaseManifest,
  | "resourceId"
  | "resourceVersion"
  | "sourceTreeHash"
  | "contractHash"
  | "schemaHash"
  | "target"
  | "compilerVersion"
  | "sdkVersion"
  | "sdkProtocolVersion"
  | "uiVersion"
  | "migrationEvidence"
>;

/** What the host's checks read and made, as a seal or a load has it. */
export interface CheckObservations {
  /** The registration both inspections read. */
  readonly manifest: AppManifest;
  /** The modules the type check passed, by flat name. */
  readonly modules: Readonly<Record<string, string>>;
  /** The SDK modules both inspections ran with, by name. */
  readonly sdk: Readonly<Record<string, string>>;
}

/** The SHA-256s of each inspection's text, as the sandbox answered it. */
export interface InspectionHashes {
  readonly symbolicInspection: string;
  readonly finalInspection: string;
}

/** The evidence of checking `release`: its identities, and the hashes of what was observed. */
const evidenceOf = async (
  release: CheckedRelease,
  observed: CheckObservations,
  inspections: InspectionHashes
): Promise<CheckEvidence> =>
  checkEvidenceSchema.parse({
    formatVersion: releaseFormatVersion,
    source: {
      resourceId: release.resourceId,
      sourceTreeHash: release.sourceTreeHash,
    },
    candidate: {
      resourceVersion: release.resourceVersion,
      contractHash: release.contractHash,
      schemaHash: release.schemaHash,
    },
    profile: {
      target: release.target,
      compilerVersion: release.compilerVersion,
      sdkVersion: release.sdkVersion,
      sdkProtocolVersion: release.sdkProtocolVersion,
      uiVersion: release.uiVersion,
    },
    observed: {
      symbolicInspection: inspections.symbolicInspection,
      finalInspection: inspections.finalInspection,
      manifest: await sha256Hex(canonicalText(observed.manifest)),
      checkedModules: await sha256Hex(canonicalJson({ ...observed.modules })),
      sdkModules: await sha256Hex(canonicalJson({ ...observed.sdk })),
      migrations: await sha256Hex(canonicalText(release.migrationEvidence)),
    },
  });

/**
 * The evidence a seal records of checking `release`, from what its checks
 * read and made and the texts its inspections answered, as the canonical
 * text it seals.
 */
export const checkEvidenceText = async (
  release: CheckedRelease,
  observed: CheckObservations,
  texts: { readonly symbolic: string; readonly final: string }
): Promise<string> =>
  canonicalText(
    await evidenceOf(release, observed, {
      symbolicInspection: await sha256Hex(texts.symbolic),
      finalInspection: await sha256Hex(texts.final),
    })
  );

/**
 * Whether `text`, a loaded release's sealed evidence, is exactly the
 * evidence of checking `release` that `observed` (read back from its
 * artifacts) makes: its identities the manifest's, and every hash that
 * can be recomputed recomputed. Never throws: hostile text is just not
 * the evidence.
 */
export const evidenceMatches = async (
  release: CheckedRelease,
  observed: CheckObservations,
  text: string
): Promise<boolean> => {
  let parsed: CheckEvidence;
  try {
    parsed = checkEvidenceSchema.parse(JSON.parse(text));
  } catch {
    return false;
  }
  const expected = await evidenceOf(release, observed, parsed.observed);
  return canonicalText(expected) === text;
};
