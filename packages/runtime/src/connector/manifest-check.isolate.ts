import type { ConnectorManifest } from "./manifest.ts";

/**
 * A connector's manifest, as its isolate has it: unchecked, and built only
 * when something reads it. Connect's build bundles a connector for its
 * isolate under the `connector-isolate` condition, which puts this in place
 * of manifest-check.ts. The build has checked the manifest this very module
 * makes before bundling it, and connect decides only by that copy, never by
 * what an isolate holds. The isolate answers MCP requests: checking again,
 * or building every tool's part of the manifest, would evaluate the
 * manifest's schemas and each tool's JSON Schemas at each load of each
 * call's isolate, which reads only the tool it calls.
 */
export const checkedManifest = (
  build: () => unknown
): (() => ConnectorManifest) => {
  let manifest: ConnectorManifest | undefined;
  // SAFETY: checked by connect's build, which bundled this module (above).
  // Unparsed here, so without the schema's defaults.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return () => (manifest ??= build() as ConnectorManifest);
};
