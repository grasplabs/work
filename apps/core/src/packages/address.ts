import type { AppId } from "@grasp-os/shared/ids";
import { packageArtifactPath } from "@grasp-os/shared/packages";
import type { PackageArtifactAddress } from "@grasp-os/shared/packages";

import { accessQuery, windowedAccess } from "../page-frame.ts";

/** A browser artifact of an App's graph, as its address names it. */
export interface ArtifactRef {
  app: AppId;
  graphHash: string;
  hash: string;
}

/** What an artifact's token is for: no other token of core's passes for it. */
export const artifactSubject = ({
  app,
  graphHash,
  hash,
}: ArtifactRef): string => `package-artifact:${app}:${graphHash}:${hash}`;

/**
 * Where artifact `ref` is served (serve.ts), for some hours: its
 * directory, on this deployment's origin, each file at its own path under
 * it, and the query each file is asked with, which carries a token core
 * made for exactly this artifact. The token is never in the path, which
 * traces keep whole (core's page-frame.ts says why); it holds until the
 * end of the next window, like a published page module's.
 */
export const packageArtifactAddress = async (
  env: Env,
  ref: ArtifactRef,
  now = Date.now()
): Promise<PackageArtifactAddress> => ({
  directory: `${packageArtifactPath}/${ref.app}/${ref.graphHash}/${ref.hash}/`,
  query: accessQuery(await windowedAccess(env, artifactSubject(ref), now)),
});
