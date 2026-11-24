/**
 * The on-prem profile's source of the embedder's model files in a workerd
 * config: the install's release directory's `blobs/models`, where the
 * release (as `release:download` writes it) keeps each model file under
 * its SHA-256, served read-only by workerd's disk service and bound to core
 * as `MODEL_SOURCE`. Core's clock copies the files of the model it runs
 * from there into its file-backed `MODEL_FILES` bucket, each checked by
 * its hash (apps/core/src/embedder.ts). No Grasp credential and no call
 * out: the files arrive with the release the install already holds.
 */
import path from "node:path";

import { modelBlobKey } from "@grasp-os/shared/release";

/** The disk service's name in the workerd config. */
export const modelSourceServiceName = "model-source";

/** The directory of `releaseDir` that holds its model files. */
export const modelFilesDir = (releaseDir: string): string =>
  path.join(releaseDir, path.dirname(modelBlobKey("x")));

/** The disk service over `releaseDir`'s model files, read-only. */
export const modelSourceService = (releaseDir: string): string =>
  `(name = "${modelSourceServiceName}", disk = (path = ${JSON.stringify(modelFilesDir(releaseDir))}, writable = false))`;

/** Core's `MODEL_SOURCE` binding, to that service. */
export const modelSourceBinding = `(name = "MODEL_SOURCE", service = "${modelSourceServiceName}")`;
