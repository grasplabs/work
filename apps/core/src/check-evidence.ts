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
import { canonicalText } from "@grasp-os/shared/json";

// A release's check evidence (`CheckEvidence`): what the host observed
// checking it as it sealed it, recorded against the identities it names
// and verified against them on every load. Threat model, and how each is
// closed:
//
// - A success report vouches for itself: the evidence holds no verdict,
//   only hashes of what the host's own checks read and made (both
//   inspection texts, the registration they read, the type-checked
//   modules, the SDK they ran with, the migration evidence). Nothing the
//   compiler or App code answers is taken for it.
// - A report made for another source, release or profile is sealed with
//   this one: it names each identity, and loading refuses it unless every
//   one is the manifest's.
// - A report vouches for code it didn't check: loading recomputes every
//   hash it can from the sealed artifacts (the modules, the SDK, the
//   registration in the contracts, the manifest's migration evidence) and
//   refuses it unless each is the report's. The inspection texts aren't
//   sealed, so their hashes are the host's record, bound by the manifest
//   hash like the rest.
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
      checkedModules: await sha256Hex(canonicalText(observed.modules)),
      sdkModules: await sha256Hex(canonicalText(observed.sdk)),
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
