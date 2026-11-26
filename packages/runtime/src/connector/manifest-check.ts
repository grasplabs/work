import { connectorManifestSchema } from "./manifest.ts";
import type { ConnectorManifest } from "./manifest.ts";

/**
 * A connector's manifest, built and checked now: throws if it isn't valid.
 * In a connector's isolate this is manifest-check.isolate.ts instead.
 */
export const checkedManifest = (
  build: () => unknown
): (() => ConnectorManifest) => {
  const manifest = connectorManifestSchema.parse(build());
  return () => manifest;
};
