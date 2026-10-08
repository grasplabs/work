import type { AppId } from "@grasp-os/shared/ids";
import { packageArtifactPath } from "@grasp-os/shared/packages";

import { windowedAccess } from "../screen-frame.ts";

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
 * directory, on this deployment's origin, with a token core made for it,
 * each file at its own path under it. The token holds until the end of the
 * next six-hour window, like a screen module's.
 */
export const packageArtifactAddress = async (
  env: Env,
  ref: ArtifactRef,
  now = Date.now()
): Promise<string> => {
  const token = await windowedAccess(env, artifactSubject(ref), now);
  return `${packageArtifactPath}/${ref.app}/${ref.graphHash}/${ref.hash}/${token}/`;
};
