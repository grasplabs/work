import { connectorManifestSchema } from "./manifest.ts";
import type { ConnectorManifest } from "./manifest.ts";

/**
 * A connector's manifest, checked: throws if it isn't valid. In a
 * connector's isolate this is manifest-check.isolate.ts instead.
 */
export const checkedManifest = (manifest: unknown): ConnectorManifest =>
  connectorManifestSchema.parse(manifest);
