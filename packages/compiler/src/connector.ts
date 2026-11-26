/**
 * The compiler's `connector` target: a connector's source, written with
 * `@grasp-os/sdk/connector`, built into the one ES module connect loads
 * into a connector's isolate (connect's connector-isolate.ts), whose
 * fetch handler is the connector's MCP server and nothing else. It is the
 * one build of a connector: connect's build.ts builds the release's with
 * it in Node, and core a connector it generates from a URL in the package
 * builder's isolate (packages/worker.ts), so the two never drift.
 *
 * A connector imports `@grasp-os/sdk/connector` and its own files, nothing
 * else: any other import fails its build (GRA-1374). The SDK comes as one
 * module built ahead (build-connectors.ts), under the `connector-isolate`
 * condition and without Zod, which an isolate would evaluate on every
 * call; so a connector's module is that and its own code alone.
 */
import { parse } from "es-module-lexer/js";
import type { build, Message, Plugin } from "esbuild-wasm";

import { withinPackage } from "./packages/build.ts";

/** What a connector imports, besides its own files. */
export const sdkConnector = "@grasp-os/sdk/connector";

/** A connector's own files, by path within its folder. */
export interface ConnectorFiles {
  /** The module that exports its connector: `src/index.ts`. */
  entry: string;
  /** The text of its file at `path`, a path within its folder, if it has one. */
  read: (path: string) => string | undefined;
}

/** A connector's module, or why it can't be built. */
export type ConnectorBuild =
  | { ok: true; code: string }
  | { ok: false; refusals: string[] };

/**
 * The isolate's main module: the connector's MCP server as its fetch
 * handler, and nothing else. Its env and context aren't passed on: the
 * connector gets neither.
 */
export const isolateEntry = (entry: string): string =>
  `import connector from ${JSON.stringify(entry)};
export default { fetch: (request) => connector.fetch(request) };
`;

/** Every path, as esbuild's filters take it: Go's syntax has no `u` flag. */
// oxlint-disable-next-line require-unicode-regexp
const anything = /.*/;

/** The isolate's main module, which imports the connector's entry. */
const main = "\0connector-main";

/** The namespaces of a connector's own modules and of the SDK's. */
const own = "connector";
const sdk = "sdk";

/** Most refusals one answer carries, each cut to a readable length. */
const maxRefusals = 20;
const refusalLength = 500;

const isMessage = (item: unknown): item is Message =>
  typeof item === "object" &&
  item !== null &&
  "text" in item &&
  typeof item.text === "string";

/** The folder of the file at `path`, with its trailing slash. */
const folderOf = (path: string): string =>
  path.slice(0, path.lastIndexOf("/") + 1);

/** Resolves the SDK and the connector's own files alone, and refuses the rest. */
const connectorPlugin = (
  { entry, read }: ConnectorFiles,
  sdkModule: string
): Plugin => ({
  name: "connector",
  setup: (builder) => {
    builder.onResolve({ filter: anything }, ({ path, importer, kind }) => {
      if (kind === "entry-point") {
        return { path: main, namespace: own };
      }
      if (importer === main) {
        return { path: entry, namespace: own };
      }
      if (path === sdkConnector) {
        return { path: sdkConnector, namespace: sdk };
      }
      const inside =
        path.startsWith("./") || path.startsWith("../")
          ? withinPackage(`${folderOf(importer)}${path}`)
          : undefined;
      if (inside === undefined || read(inside) === undefined) {
        return {
          errors: [
            {
              text: `${importer} imports "${path}": a connector imports ${sdkConnector} and its own files, nothing else.`,
            },
          ],
        };
      }
      return { path: inside, namespace: own };
    });
    builder.onLoad({ filter: anything, namespace: sdk }, () => ({
      contents: sdkModule,
      loader: "js",
    }));
    builder.onLoad({ filter: anything, namespace: own }, ({ path }) => {
      if (path === main) {
        return { contents: isolateEntry(entry), loader: "js" };
      }
      const contents = read(path);
      if (contents === undefined) {
        return { errors: [{ text: `${path} isn't among its files` }] };
      }
      return { contents, loader: path.endsWith(".ts") ? "ts" : "js" };
    });
  },
});

/**
 * Builds the connector of `files` into one ES module, with `sdkModule`
 * (build-connectors.ts) as `@grasp-os/sdk/connector`, by `esbuild`'s
 * `build`, which its caller started.
 */
export const buildConnector = async (
  files: ConnectorFiles,
  sdkModule: string,
  esbuild: typeof build
): Promise<ConnectorBuild> => {
  if (
    withinPackage(files.entry) !== files.entry ||
    files.read(files.entry) === undefined
  ) {
    return { ok: false, refusals: [`${files.entry} isn't among its files`] };
  }
  try {
    const result = await esbuild({
      entryPoints: [main],
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      minify: true,
      write: false,
      logLevel: "silent",
      plugins: [connectorPlugin(files, sdkModule)],
    });
    const [output, ...rest] = result.outputFiles;
    if (output === undefined || rest.length > 0) {
      return { ok: false, refusals: ["It didn't build into one module"] };
    }
    // What esbuild only warns of is refused too, and so is an import it
    // left in the module: an `import()` of a computed value, which no
    // resolver sees.
    const [imports] = parse(output.text);
    const refusals = [
      ...result.warnings.map(({ text }) => text.slice(0, refusalLength)),
      ...(imports.some(({ type }) => type !== "import-meta")
        ? [
            "It imports a module as it runs: a connector imports nothing but the SDK and its own files, as it is built.",
          ]
        : []),
    ];
    return refusals.length === 0
      ? { ok: true, code: output.text }
      : { ok: false, refusals: refusals.slice(0, maxRefusals) };
  } catch (error) {
    // esbuild fails a build with its messages; anything else is thrown on.
    const errors: unknown =
      typeof error === "object" && error !== null
        ? Reflect.get(error, "errors")
        : undefined;
    if (!Array.isArray(errors)) {
      throw error;
    }
    const texts = errors
      .filter(isMessage)
      .map(({ text }) => text.slice(0, refusalLength));
    return { ok: false, refusals: [...new Set(texts)].slice(0, maxRefusals) };
  }
};
