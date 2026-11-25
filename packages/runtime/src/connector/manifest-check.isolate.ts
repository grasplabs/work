import type { ConnectorManifest } from "./manifest.ts";

/**
 * A connector's manifest, as its isolate has it: unchecked. Connect's build
 * bundles a connector for its isolate under the `connector-isolate`
 * condition, which puts this in place of manifest-check.ts. The build has
 * checked the manifest this very module makes before bundling it, and
 * connect decides only by that copy, never by what an isolate holds. The
 * isolate answers MCP requests, and checking again there would evaluate
 * the manifest's schemas, and Zod, at each load of each call's isolate.
 */
export const checkedManifest = (manifest: unknown): ConnectorManifest =>
  // SAFETY: checked by connect's build, which bundled this module (above).
  // Unparsed here, so without the schema's defaults: the isolate reads only
  // its `name`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  manifest as ConnectorManifest;
