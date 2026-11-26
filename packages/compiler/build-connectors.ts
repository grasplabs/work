/**
 * The `connector` target (src/connector.ts) as it runs in Node: for
 * connect's build, which builds the release's connectors with it, and for
 * the package builder's build (build-package-builder.ts), which carries
 * the SDK module it builds connectors with in core.
 */
import { build as esbuild } from "esbuild-wasm";
import { build, defaultClientConditions } from "vite-plus";
import type { Rolldown } from "vite-plus";

import { buildConnector, sdkConnector } from "./src/connector.ts";
import type { ConnectorBuild, ConnectorFiles } from "./src/connector.ts";

const root = import.meta.dirname;

const entryId = "\0connector-sdk";

/**
 * The condition a connector is built for its isolate under: the runtime's
 * modules that only connect and its build need there take an isolate's
 * form under it (the runtime's `#connector-manifest`).
 */
const isolateCondition = "connector-isolate";

/** Part of the path of each of Zod's modules. */
const zodModule = /[\\/]node_modules[\\/]zod[\\/]/u;

/**
 * `@grasp-os/sdk/connector` as one ES module, for its isolate. It must not
 * load Zod: an isolate evaluates its whole module each time it loads, once
 * per call, and Zod with the schemas made with it took most of a call's
 * time.
 */
export const buildConnectorSdk = async (): Promise<string> => {
  const result = await build({
    configFile: false,
    root,
    logLevel: "warn",
    mode: "production",
    plugins: [
      {
        name: "connector-sdk",
        resolveId: (id) => (id === entryId ? id : null),
        load: (id) =>
          id === entryId
            ? `export * from ${JSON.stringify(sdkConnector)};`
            : null,
      },
    ],
    resolve: { conditions: [...defaultClientConditions, isolateCondition] },
    build: {
      write: false,
      minify: true,
      target: "es2022",
      modulePreload: false,
      copyPublicDir: false,
      rolldownOptions: {
        input: entryId,
        preserveEntrySignatures: "strict",
        // The runtime's own modules, which an isolate refuses anyway: it
        // gets no env and no bindings to import.
        external: [/^cloudflare:/u],
        output: { format: "es", codeSplitting: false },
      },
    },
  });
  const chunks: Rolldown.OutputChunk[] = [result]
    .flat()
    .flatMap((output) => ("output" in output ? output.output : []))
    .filter((file) => file.type === "chunk");
  const [chunk, ...rest] = chunks;
  if (chunk === undefined || rest.length > 0) {
    throw new Error(`${sdkConnector} didn't build into one module`);
  }
  if (Object.keys(chunk.modules).some((id) => zodModule.test(id))) {
    throw new Error(`${sdkConnector} would load Zod in a connector's isolate`);
  }
  return chunk.code;
};

/**
 * The `connector` target in Node, with the SDK's module built once for
 * every connector it builds.
 */
export const connectorBuilder = async (): Promise<
  (files: ConnectorFiles) => Promise<ConnectorBuild>
> => {
  const sdkModule = await buildConnectorSdk();
  return async (files) => await buildConnector(files, sdkModule, esbuild);
};
