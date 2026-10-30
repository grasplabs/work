/**
 * A built release under the id it's published as: CI builds it under a
 * local id (`dev-<time>`) and its publish gives it the next `YY.MM.N`
 * (upload-release.ts --assign-id); the one-off rename of the first
 * staging releases gives the old ones theirs. Only the manifest's id and
 * the limit evidence's ids change: the blobs, and everything else in both
 * files, stay as they were built and checked.
 */
import {
  limitEvidenceFileSchema,
  releaseManifestSchema,
} from "@grasp-os/shared/release";
import type { ReleaseManifest } from "@grasp-os/shared/release";
import { z } from "zod";

import { stableStringify } from "./hash-lib.ts";

const text = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);

const looseEvidence = z.looseObject({
  previousRelease: z.looseObject({ releaseId: z.string() }).nullable(),
  limitEvidence: z.array(z.looseObject({})),
});

export interface StampedRelease {
  manifest: ReleaseManifest;
  manifestBytes: Buffer;
  evidenceBytes: Buffer | undefined;
}

/**
 * The manifest and limit evidence (when there is one) as release `id`'s,
 * written as the build and the evidence step write them. `previousId`
 * renames the release the evidence says came before, for a rename of
 * several releases at once.
 */
export const stampReleaseId = (
  manifestBytes: Uint8Array,
  evidenceBytes: Uint8Array | undefined,
  id: string,
  previousId: (old: string) => string = (old) => old
): StampedRelease => {
  // Read loosely and checked once stamped: the id it had may be one this
  // code no longer takes (the rename of the first staging releases).
  const manifest = releaseManifestSchema.parse({
    ...z.looseObject({}).parse(JSON.parse(text(manifestBytes))),
    releaseId: id,
  });
  const stampedManifest = Buffer.from(stableStringify(manifest));
  if (evidenceBytes === undefined) {
    return {
      manifest,
      manifestBytes: stampedManifest,
      evidenceBytes: undefined,
    };
  }
  const evidence = looseEvidence.parse(JSON.parse(text(evidenceBytes)));
  const stamped = limitEvidenceFileSchema.parse({
    ...evidence,
    releaseId: id,
    previousRelease:
      evidence.previousRelease === null
        ? null
        : {
            ...evidence.previousRelease,
            releaseId: previousId(evidence.previousRelease.releaseId),
          },
    limitEvidence: evidence.limitEvidence.map((entry) => ({
      ...entry,
      releaseId: id,
    })),
  });
  return {
    manifest,
    manifestBytes: stampedManifest,
    evidenceBytes: Buffer.from(`${JSON.stringify(stamped, null, 2)}\n`),
  };
};
