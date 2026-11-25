/**
 * Builds the native connectors into dist/connectors.js, once per release at
 * connect's build time: every package in packages/connectors, each as its
 * manifest and its MCP server bundled into one ES module. Connect imports
 * the result through `#connectors` and loads a connector's module into an
 * isolate of its own for each call, so adding a connector is adding a
 * package: no Worker, no wrangler.jsonc entry.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { checkMirror } from "@grasp-os/compiler/mirror";
import { readSpec } from "@grasp-os/compiler/openapi";
import type { Spec } from "@grasp-os/compiler/openapi";
import { connectorManifestSchema } from "@grasp-os/runtime/connector";
import type {
  ConnectorDeclaration,
  ConnectorManifest,
} from "@grasp-os/runtime/connector";
import { build } from "vite-plus";
import type { Plugin, Rolldown } from "vite-plus";
import { z } from "zod";

const root = import.meta.dirname;
const packages = path.join(root, "../../packages/connectors");

/** Where connect's `#connectors` import finds the release's connectors. */
export const connectorsFile = path.join(root, "dist/connectors.js");

const packageSchema = z.object({
  exports: z.object({ ".": z.string() }),
  dependencies: z.record(z.string(), z.string()).optional(),
});

/** A connector package's folder and its package.json. */
const connectorPackages = (): {
  dir: string;
  manifest: z.infer<typeof packageSchema>;
}[] =>
  readdirSync(packages)
    .map((dir) => path.join(packages, dir))
    .filter((dir) => existsSync(path.join(dir, "package.json")))
    .map((dir) => ({
      dir,
      manifest: packageSchema.parse(
        JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8"))
      ),
    }));

/** Every connector package's entry module. */
export const connectorEntries = (): string[] =>
  connectorPackages().map(({ dir, manifest }) => {
    const entry = path.resolve(dir, manifest.exports["."]);
    // A package builds only its own code, never a file outside its folder.
    if (!entry.startsWith(`${dir}${path.sep}`)) {
      throw new Error(`${dir}'s entry is outside its folder`);
    }
    return entry;
  });

const moduleSchema = z.object({
  default: z.object({
    manifest: z.unknown(),
    // A connector written on `sdkConnector` has its declaration; one on the
    // old kit hasn't, and isn't on the SDK until it moves.
    declaration: z
      .custom<ConnectorDeclaration>(
        (value) => typeof value === "object" && value !== null
      )
      .optional(),
  }),
});

/**
 * The spec a connector declares, from the file beside its entry
 * (`openapi.yaml` or `openapi.json`, as scripts/connector-openapi.ts writes
 * it), which must be the text its tools were generated from.
 */
const specBeside = async (
  entry: string,
  openapi: NonNullable<ConnectorDeclaration["openapi"]>
): Promise<Spec> => {
  const file = ["openapi.yaml", "openapi.json"]
    .map((name) => path.join(path.dirname(entry), name))
    .find((each) => existsSync(each));
  if (file === undefined) {
    throw new Error(`${entry} declares an OpenAPI spec, and none is beside it`);
  }
  const spec = await readSpec(readFileSync(file, "utf-8"), openapi.url);
  if (spec.sha256 !== openapi.sha256) {
    throw new Error(`${file} isn't the spec ${entry} was generated from`);
  }
  return spec;
};

/**
 * Holds a connector written on `sdkConnector` to the mirror rule
 * (GRA-2319): each tool named from its route, and where it declares its
 * vendor's spec, each argument and answer field as the spec has it. The
 * build fails on any tool that breaks it.
 */
const checkMirrorOf = async (
  entry: string,
  declaration: ConnectorDeclaration
): Promise<void> => {
  const spec =
    declaration.openapi === undefined
      ? undefined
      : await specBeside(entry, declaration.openapi);
  const problems = checkMirror(
    Object.entries(declaration.tools).map(([name, each]) => ({
      name,
      routes: each.routes,
      args: each.args,
      returns: each.returns,
    })),
    spec
  );
  if (problems.length > 0) {
    const lines = problems.map(({ tool, message }) => `${tool}: ${message}`);
    throw new Error(
      `${declaration.name} breaks the mirror rule:\n${lines.join("\n")}`
    );
  }
};

const entryId = "\0connector-entry";

/** What a connector imports, besides its own files. */
const sdkConnector = "@grasp-os/sdk/connector";

/**
 * The code still written with the old kit, Zod and the runtime, which may
 * import what it does until it moves to `sdkConnector` (GRA-2323,
 * GRA-2324, GRA-2329): every connector package that depends on the kit,
 * and the sample connectors of connect's tests written with it.
 */
const oldKit = [
  ...connectorPackages()
    .filter(({ manifest }) =>
      Object.hasOwn(manifest.dependencies ?? {}, "@grasp-os/connector-kit")
    )
    .map(({ dir }) => dir),
  ...[
    "sample-connector.ts",
    "sample-sync-connector.ts",
    "sample-oauth-connector.ts",
    "composio-named-connector.ts",
  ].map((file) => path.join(root, "test/fixtures", file)),
];

/** Whether `file` is `folder` or inside it. */
const isWithin = (folder: string, file: string): boolean =>
  file === folder || file.startsWith(`${folder}${path.sep}`);

/**
 * The folder of a connector's own files, from its `entry`: its package's,
 * for a package in packages/connectors, and else the entry's own folder,
 * so a sample connector of connect's tests reaches none of connect's code.
 */
const ownFolderOf = (entry: string): string => {
  const [name] = path.relative(packages, entry).split(path.sep);
  return isWithin(packages, entry) && name !== undefined
    ? path.join(packages, name)
    : path.dirname(entry);
};

/**
 * Refuses, while bundling, any import a module of the connector's own
 * package makes but of `sdkConnector` and of its own files: the build
 * fails rather than ship a connector that reaches past what it is written
 * with (GRA-1374). Type-only imports never get here: the transform erased
 * them.
 */
const connectorImports = (folder: string): Plugin => ({
  name: "connector-imports",
  // Before Vite's own resolver, which would resolve the import first.
  enforce: "pre",
  resolveId: (source, importer) => {
    if (
      importer === undefined ||
      source.startsWith("\0") ||
      !isWithin(folder, importer) ||
      importer.split(path.sep).includes("node_modules") ||
      oldKit.some((each) => isWithin(each, importer))
    ) {
      return null;
    }
    const ownFile =
      (source.startsWith("./") || source.startsWith("../")) &&
      isWithin(folder, path.resolve(path.dirname(importer), source));
    if (source === sdkConnector || ownFile) {
      return null;
    }
    throw new Error(
      `${importer} imports "${source}": a connector imports ${sdkConnector} and its own files, nothing else.`
    );
  },
});

/**
 * The isolate's main module: the connector's MCP server as its fetch
 * handler, and nothing else. Its env and context aren't passed on: the
 * connector gets neither.
 */
const entryModule = (entry: string): Plugin => ({
  name: "connector-entry",
  resolveId: (id) => (id === entryId ? id : null),
  load: (id) =>
    id === entryId
      ? `import connector from ${JSON.stringify(entry)};
export default { fetch: (request) => connector.fetch(request) };`
      : null,
});

const chunksOf = (
  result: Awaited<ReturnType<typeof build>>
): Rolldown.OutputChunk[] =>
  [result]
    .flat()
    .flatMap((output) => ("output" in output ? output.output : []))
    .filter((file) => file.type === "chunk");

/** The connector at `entry`, bundled with what it imports into one module. */
const bundle = async (entry: string): Promise<string> => {
  const chunks = chunksOf(
    await build({
      configFile: false,
      root,
      logLevel: "warn",
      mode: "production",
      plugins: [connectorImports(ownFolderOf(entry)), entryModule(entry)],
      build: {
        write: false,
        minify: true,
        target: "es2022",
        modulePreload: false,
        copyPublicDir: false,
        rolldownOptions: {
          input: entryId,
          preserveEntrySignatures: "strict",
          // The runtime's own modules, which the isolate refuses anyway:
          // it gets no env and no bindings to import.
          external: [/^cloudflare:/u],
          output: { format: "es", codeSplitting: false },
        },
      },
    })
  );
  const [chunk] = chunks;
  if (chunk === undefined || chunks.length !== 1) {
    throw new Error(`${entry} didn't bundle into one module`);
  }
  return chunk.code;
};

/**
 * Builds the connectors at `entries` into `outFile`. Each one's manifest
 * comes from its module (so the manifest and the tools can't drift apart)
 * and must be valid; two connectors may not share a name.
 *
 * Reading the manifest runs the connector's module in Node, at build time,
 * with the build's access (CI's): connector code and its dependencies are
 * trusted as all of our code is, reviewed, pinned and aged (threat model
 * EG4, CI2).
 */
export const buildConnectors = async (
  entries: readonly string[],
  outFile: string
): Promise<void> => {
  const connectors: { manifest: ConnectorManifest; code: string }[] = [];
  for (const entry of entries) {
    const loaded = moduleSchema.parse(
      // oxlint-disable-next-line no-await-in-loop -- one connector at a time
      await import(pathToFileURL(entry).href)
    );
    const manifest = connectorManifestSchema.parse(loaded.default.manifest);
    if (loaded.default.declaration !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- one connector at a time
      await checkMirrorOf(entry, loaded.default.declaration);
    }
    if (connectors.some((each) => each.manifest.name === manifest.name)) {
      throw new Error(`Two connectors are named ${manifest.name}`);
    }
    // An app's record says how to sign in to it, and its connector gets its
    // token: one connector per app, so neither is in doubt.
    if (
      manifest.signIn !== undefined &&
      connectors.some((each) => each.manifest.provider === manifest.provider)
    ) {
      throw new Error(`Two connectors are for the app ${manifest.provider}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- one connector at a time
    connectors.push({ manifest, code: await bundle(entry) });
  }
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, `export default ${JSON.stringify(connectors)};\n`);
  for (const { manifest, code } of connectors) {
    console.info(
      `Connector ${manifest.name}: ${(code.length / 1e3).toFixed(0)} kB`
    );
  }
};

if (import.meta.main) {
  await buildConnectors(connectorEntries(), connectorsFile);
}
