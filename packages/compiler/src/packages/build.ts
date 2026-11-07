/**
 * Builds an approved lock into one ES module per entry, in the package
 * builder's isolate (worker.ts): no network, no bindings, nothing of the
 * packages run. Core checked every tarball against the lock's integrity
 * before it handed it over. What a package could try here, and what
 * stops it:
 *
 * - Reaching a package nobody approved: every bare import is resolved
 *   through the importing package's own edges in the lock, to that exact
 *   version, never a package it merely shares a graph with. Node's
 *   built-ins (`fs`, `node:crypto`) are no package of the lock, so they
 *   are refused like any other.
 * - Leaving its own files: a path is resolved inside its package or not
 *   at all (`..` out of it, an absolute path, another `node_modules`).
 *   The tarball's links, devices and other non-files are never read.
 * - Loading code at run time from elsewhere: a URL import (`https:`,
 *   `data:`, `//`) is refused; every module is bundled, so nothing is
 *   fetched when it runs.
 * - An archive bomb: unpacking counts gzip's output and stops past
 *   `packageLimits.extractedBytes` for the whole graph.
 *
 * What the code does once it runs is bounded where it runs: a workflow's
 * compute sandbox, locked down before any module evaluates.
 */
import { entryPackage, packageLimits } from "@grasp-os/shared/packages";
import type {
  GraspLock,
  PackageBuildAnswer,
  PackageTarball,
} from "@grasp-os/shared/packages";
import type { Message, OnResolveResult, Plugin } from "esbuild-wasm";
import { build, initialize } from "esbuild-wasm/esm/browser.js";
import { unpackTar } from "modern-tar";
import {
  exports as exportsOf,
  imports as importsOf,
  legacy,
} from "resolve.exports";

import { kitPeers } from "../kit.ts";

/**
 * Where a build runs: a page, in the browser, beside the kit's React; or
 * an isolate (an App's server code, a workflow's compute), a Worker's.
 */
export type PackageTarget = "browser" | "worker";

/** The conditions a package's `exports` are read with, by target. */
const conditionsOf: Record<PackageTarget, string[]> = {
  browser: ["browser", "import", "module"],
  worker: ["workerd", "worker", "import", "module"],
};

/** React's own packages: in a page, only ever the kit's. */
const reactPackages = new Set(["react", "react-dom"]);

/** The extensions and index files Node tries for a path without one. */
const candidates = (path: string): string[] => [
  path,
  ...[".js", ".mjs", ".cjs", ".json"].map((extension) => `${path}${extension}`),
  ...["index.js", "index.mjs", "index.cjs", "index.json"].map((index) =>
    path === "" ? index : `${path}/${index}`
  ),
];

/** A URL rather than a path: anything with a scheme, or protocol-relative. */
const remote = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu;

/**
 * Every path, as esbuild's filters take it: a Go regular expression,
 * which has no `u` flag.
 */
// oxlint-disable-next-line require-unicode-regexp
const anything = /.*/;

/** One package's files, by path within it, and its package.json. */
interface Unpacked {
  files: Map<string, Uint8Array>;
  manifest: Record<string, unknown>;
}

/** A path within a package, normalised, or undefined if it would leave it. */
export const withinPackage = (path: string): string | undefined => {
  if (path.startsWith("/") || path.includes("\\")) {
    return undefined;
  }
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "..") {
      if (segments.pop() === undefined) {
        return undefined;
      }
    } else if (segment !== "." && segment !== "") {
      segments.push(segment);
    }
  }
  return segments.includes("node_modules") ? undefined : segments.join("/");
};

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** Why a build stops, in words the person who asked for it reads. */
class RefusedError extends Error {
  override name = "RefusedError";
}

/**
 * A gzipped tarball's bytes, decompressed, failing past `budget.left`
 * bytes, which it spends.
 */
const gunzipped = (
  tarball: Uint8Array,
  budget: { left: number }
): ReadableStream<Uint8Array> =>
  new Blob([new Uint8Array(tarball)])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          budget.left -= chunk.byteLength;
          if (budget.left < 0) {
            throw new RefusedError(
              "The packages unpack to more than a build holds."
            );
          }
          controller.enqueue(chunk);
        },
      })
    );

/**
 * One tarball's files, its first directory (npm's `package/`) taken off:
 * plain files only, each inside the package.
 */
const unpack = async (
  key: string,
  tarball: Uint8Array,
  budget: { left: number }
): Promise<Unpacked> => {
  let entries: Awaited<ReturnType<typeof unpackTar>>;
  try {
    entries = await unpackTar(gunzipped(tarball, budget), {
      strict: true,
      strip: 1,
    });
  } catch (error) {
    throw error instanceof RefusedError
      ? error
      : new RefusedError(`${key}: its tarball can't be read.`);
  }
  const files = new Map<string, Uint8Array>();
  for (const { header, data } of entries) {
    const path = withinPackage(header.name);
    if (
      (header.type ?? "file") === "file" &&
      path !== undefined &&
      path !== ""
    ) {
      files.set(path, data ?? new Uint8Array());
    }
  }
  const json = files.get("package.json");
  let manifest: unknown;
  try {
    manifest = json === undefined ? undefined : JSON.parse(utf8.decode(json));
  } catch {
    manifest = undefined;
  }
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    throw new RefusedError(`${key}: its package.json can't be read.`);
  }
  return { files, manifest: { ...manifest } };
};

/** The first file of `path`'s candidates a package has. */
const fileOf = (pkg: Unpacked, path: string): string | undefined =>
  candidates(path).find((candidate) => pkg.files.has(candidate));

/**
 * Where `subpath` (`.` or `./x`) of a package leads, as Node reads its
 * package.json: `exports` if it has them, else `module` or `main` for the
 * package itself, else the path. Undefined when nothing matches.
 */
const exported = (
  pkg: Unpacked,
  subpath: string,
  conditions: readonly string[]
): string | undefined => {
  let target: string | undefined;
  if (pkg.manifest.exports === undefined) {
    target =
      subpath === "."
        ? (legacy(pkg.manifest, {
            browser: false,
            fields: ["module", "main"],
          }) ?? ".")
        : subpath;
  } else {
    try {
      target = exportsOf(pkg.manifest, subpath, {
        conditions,
        unsafe: true,
      })?.[0];
    } catch {
      target = undefined;
    }
  }
  const path = target === undefined ? undefined : withinPackage(target);
  return path === undefined ? undefined : fileOf(pkg, path);
};

/** Where a module is: its package's `name@version` and its file. */
interface Located {
  key: string;
  file: string;
}

const located = ({ key, file }: Located): OnResolveResult => ({
  path: `${key}/${file}`,
  namespace: "pkg",
  pluginData: { key, file } satisfies Located,
});

const refused = (text: string): OnResolveResult => ({ errors: [{ text }] });

const isLocated = (value: unknown): value is Located =>
  typeof value === "object" &&
  value !== null &&
  "key" in value &&
  "file" in value &&
  typeof value.key === "string" &&
  typeof value.file === "string";

/**
 * The plugin that resolves and loads every module of a build from the
 * lock's packages alone (see the top of this file).
 */
const lockPlugin = (
  lock: GraspLock,
  packages: ReadonlyMap<string, Unpacked>,
  target: PackageTarget
): Plugin => {
  const conditions = conditionsOf[target];
  /** Package `name` as `from` depends on it, or as the lock's direct one. */
  const dependency = (name: string, from?: Located): string | undefined => {
    const edges =
      from === undefined ? lock.direct : lock.packages[from.key]?.dependencies;
    const version =
      edges === undefined || !Object.hasOwn(edges, name)
        ? undefined
        : edges[name];
    return version === undefined ? undefined : `${name}@${version}`;
  };
  const bare = (specifier: string, from?: Located): OnResolveResult => {
    const name = entryPackage(specifier);
    const who = from?.key ?? "The code";
    // A page's React is the kit's, whatever version a package asks for:
    // left for the page build to point at the kit's module, and refused
    // past what the kit has, never bundled as a second copy.
    if (target === "browser" && reactPackages.has(name)) {
      return kitPeers.includes(specifier)
        ? { path: specifier, external: true }
        : refused(
            `${who} imports ${specifier}, which the kit's React doesn't have.`
          );
    }
    const key = dependency(name, from);
    const pkg = key === undefined ? undefined : packages.get(key);
    if (key === undefined || pkg === undefined) {
      return refused(
        `${who} imports ${name}, which it doesn't depend on in the lock.`
      );
    }
    const subpath = `.${specifier.slice(name.length)}`;
    const file = exported(pkg, subpath, conditions);
    return file === undefined
      ? refused(`${who} imports ${specifier}, which ${key} doesn't export.`)
      : located({ key, file });
  };
  return {
    name: "grasp-lock",
    setup: (on) => {
      on.onResolve({ filter: anything }, ({ path, pluginData, kind }) => {
        const from = isLocated(pluginData) ? pluginData : undefined;
        if (kind === "entry-point") {
          return bare(path);
        }
        if (remote.test(path)) {
          return refused(
            `${from?.key ?? "The code"} imports ${path}, which is never fetched.`
          );
        }
        if (from === undefined) {
          return refused(`Nothing imports ${path}.`);
        }
        const pkg = packages.get(from.key);
        if (pkg === undefined) {
          return refused(`${from.key} isn't in the lock.`);
        }
        // Relative to the importing file, or, for an `imports` target, to
        // the package's root.
        let inside: string | undefined;
        if (path.startsWith("#")) {
          let mapped: string | undefined;
          try {
            mapped = importsOf(pkg.manifest, path, {
              conditions,
              unsafe: true,
            })?.[0];
          } catch {
            mapped = undefined;
          }
          if (mapped === undefined) {
            return refused(
              `${from.key} imports ${path}, which it doesn't map.`
            );
          }
          if (!mapped.startsWith("./")) {
            return bare(mapped, from);
          }
          inside = withinPackage(mapped);
        } else if (path.startsWith(".")) {
          const slash = from.file.lastIndexOf("/");
          inside = withinPackage(
            slash === -1 ? path : `${from.file.slice(0, slash)}/${path}`
          );
        } else if (!path.startsWith("/")) {
          return bare(path, from);
        }
        const file = inside === undefined ? undefined : fileOf(pkg, inside);
        return file === undefined
          ? refused(
              `${from.key} imports ${path}, which isn't a file of its own.`
            )
          : located({ key: from.key, file });
      });
      on.onLoad({ filter: anything, namespace: "pkg" }, ({ pluginData }) => {
        if (!isLocated(pluginData)) {
          return {
            errors: [{ text: "A module was loaded without its package." }],
          };
        }
        const bytes = packages.get(pluginData.key)?.files.get(pluginData.file);
        const extension = pluginData.file.slice(
          pluginData.file.lastIndexOf(".")
        );
        const loader = extension === ".json" ? "json" : "js";
        if (
          bytes === undefined ||
          ![".js", ".mjs", ".cjs", ".json"].includes(extension)
        ) {
          return {
            errors: [
              {
                text: `${pluginData.key} imports ${pluginData.file}, which isn't code.`,
              },
            ],
          };
        }
        // Its imports are resolved from where it is.
        return { contents: bytes, loader, pluginData };
      });
    },
  };
};

/** esbuild, started once per isolate on the module it was loaded with. */
let started: Promise<void> | undefined;

/** Most refusals one answer carries, each cut to what core takes. */
const maxRefusals = 50;
const refusalLength = 500;

const isMessage = (item: unknown): item is Message =>
  typeof item === "object" &&
  item !== null &&
  "text" in item &&
  typeof item.text === "string";

const refusalsOf = (messages: readonly Message[]): string[] =>
  [...new Set(messages.map(({ text }) => text.slice(0, refusalLength)))].slice(
    0,
    maxRefusals
  );

/**
 * Builds each entry of `lock` into one self-contained ES module, from the
 * tarballs core checked against it.
 */
export const buildLock = async (
  lock: GraspLock,
  tarballs: readonly PackageTarball[],
  target: PackageTarget,
  wasmModule: WebAssembly.Module
): Promise<PackageBuildAnswer> => {
  started ??= initialize({ wasmModule, worker: false });
  await started;
  const packages = new Map<string, Unpacked>();
  const budget = { left: packageLimits.extractedBytes };
  try {
    for (const { key, tarball } of tarballs) {
      // One at a time: each spends the graph's budget as it unpacks.
      // oxlint-disable-next-line no-await-in-loop
      packages.set(key, await unpack(key, tarball, budget));
    }
  } catch (error) {
    if (error instanceof RefusedError) {
      return { ok: false, refusals: [error.message] };
    }
    throw error;
  }
  const modules: Record<string, string> = {};
  // Each entry on its own: one that can't run here (a page's chart in an
  // isolate, say) leaves the others, and says why.
  const unbuilt: Record<string, string[]> = {};
  for (const entry of lock.entries) {
    try {
      // One entry at a time: esbuild's memory is the isolate's.
      // oxlint-disable-next-line no-await-in-loop
      const result = await build({
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        platform: "neutral",
        write: false,
        logLevel: "silent",
        plugins: [lockPlugin(lock, packages, target)],
      });
      modules[entry] = result.outputFiles[0]?.text ?? "";
    } catch (error) {
      // esbuild fails a build with its messages; anything else is thrown on.
      const errors: unknown =
        typeof error === "object" && error !== null
          ? Reflect.get(error, "errors")
          : undefined;
      if (!Array.isArray(errors)) {
        throw error;
      }
      unbuilt[entry] = refusalsOf(errors.filter(isMessage));
    }
  }
  return { ok: true, modules, refused: unbuilt };
};
