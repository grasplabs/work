import type { DependencyTarget } from "@grasp-os/shared/dependencies";
/**
 * One target's build of an approved lock, in the package builder's
 * isolate: each tarball checked against the lock's integrity again,
 * unpacked (keeping only what a build reads), bundled (bundle.ts) and
 * measured, with nothing run. The answer says every file the artifact
 * has, with its SHA-256, which core checks before keeping any of it.
 */
import { toHex } from "@grasp-os/shared/encoding";
import type {
  GraspLock,
  PackageArtifact,
  PackageBuildAnswer,
  PackageInspection,
  PackageLimits,
  PackageTarball,
} from "@grasp-os/shared/packages";
import { initialize } from "esbuild-wasm/esm/browser.js";

import { assetTypes, bundle, isBuildable } from "./bundle.ts";
import type { PackageFiles } from "./exports.ts";
import { inspectPackage } from "./inspect.ts";
import { TarballRefusedError } from "./refused.ts";
import { extractTarball } from "./tarball.ts";

/** What core asks the builder to build. */
export interface BuildRequest {
  limits: PackageLimits;
  lock: GraspLock;
  target: DependencyTarget;
  packages: PackageTarball[];
}

/** esbuild's WebAssembly memory, once it started: what a build holds. */
let wasmMemory: WebAssembly.Memory | undefined;

/**
 * Starts esbuild once per isolate, on the WebAssembly module the isolate
 * was loaded with: no worker, no URL, nothing fetched. Its instance's
 * memory is kept, to measure.
 */
let started: Promise<void> | undefined;
const startEsbuild = async (wasmModule: WebAssembly.Module): Promise<void> => {
  started ??= (async () => {
    const instantiate = WebAssembly.instantiate.bind(WebAssembly);
    // Go's runtime instantiates the module itself, with what it imports;
    // this sees the instance's memory on the way, to measure it.
    const measured = async (
      module: WebAssembly.Module,
      imports?: WebAssembly.Imports
    ): Promise<WebAssembly.Instance> => {
      const instance = await instantiate(module, imports);
      const memory = instance.exports.mem;
      if (memory instanceof WebAssembly.Memory) {
        wasmMemory = memory;
      }
      return instance;
    };
    Reflect.set(WebAssembly, "instantiate", measured);
    try {
      await initialize({ wasmModule, worker: false });
    } finally {
      Reflect.set(WebAssembly, "instantiate", instantiate);
    }
  })();
  await started;
};

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** The type an artifact's file is served with. */
const typeOf = (path: string): string => {
  if (path.endsWith(".js")) {
    return "text/javascript";
  }
  if (path.endsWith(".css")) {
    return "text/css";
  }
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  return assetTypes[extension] ?? "application/octet-stream";
};

const sha256 = async (bytes: Uint8Array): Promise<string> =>
  toHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))
  );

/**
 * Where the lock's edges for a package aren't what its own package.json
 * asks for: the dependencies it names (optional ones left out, as when
 * resolving) must be exactly the lock's, or the graph built isn't the
 * graph the tarball needs.
 */
const lockEdgeRefusals = (
  lock: GraspLock,
  key: string,
  inspection: PackageInspection
): string[] => {
  const entry = lock.packages[key];
  const { manifest } = inspection;
  if (entry === undefined || manifest === null) {
    return entry === undefined ? ["it isn't a package of the lock"] : [];
  }
  const required = Object.keys(manifest.dependencies)
    .filter((name) => !Object.hasOwn(manifest.optionalDependencies, name))
    .toSorted();
  const locked = Object.keys(entry.dependencies).toSorted();
  return JSON.stringify(required) === JSON.stringify(locked)
    ? []
    : ["its package.json depends on other packages than the lock names"];
};

/** Whether `value` is an `exports`/`imports` target in every part. */
const isTarget = (value: unknown, depth = 0): boolean => {
  if (depth > 16) {
    return false;
  }
  if (value === null || typeof value === "string") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isTarget(item, depth + 1));
  }
  return (
    typeof value === "object" &&
    Object.values(value).every((item) => isTarget(item, depth + 1))
  );
};

/** Whether `value` is a `browser` field: a path, or paths and names to a path or `false`. */
const isBrowserField = (value: unknown): boolean =>
  typeof value === "string" ||
  (typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (item) => typeof item === "string" || item === false
    ));

/**
 * Why the fields a build resolves imports by can't be read, if they
 * can't: each is read whole or the package refused, never a malformed
 * one skipped for a fallback (`main` wrong, so `index.js`).
 */
const manifestShapeRefusal = (manifest: object): string | undefined => {
  const field = (name: string): unknown =>
    Object.hasOwn(manifest, name) ? Reflect.get(manifest, name) : undefined;
  const wrong = [
    ["main", (value: unknown) => typeof value === "string"],
    ["module", (value: unknown) => typeof value === "string"],
    ["browser", isBrowserField],
    ["exports", (value: unknown) => isTarget(value)],
    [
      "imports",
      (value: unknown) =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        isTarget(value),
    ],
  ] as const;
  const bad = wrong
    .filter(([name, valid]) => field(name) !== undefined && !valid(field(name)))
    .map(([name]) => name);
  return bad.length === 0
    ? undefined
    : `its package.json's ${bad.join(", ")} can't be read`;
};

/** Each package unpacked for building, or the first reason one can't be. */
const unpackAll = async ({
  limits,
  lock,
  packages,
}: BuildRequest): Promise<
  | {
      ok: true;
      unpacked: Map<string, PackageFiles>;
      files: number;
      bytes: number;
    }
  | { ok: false; refusals: string[] }
> => {
  const unpacked = new Map<string, PackageFiles>();
  let files = 0;
  let bytes = 0;
  let extractedBytes = 0;
  if (packages.length > limits.graphPackages) {
    return {
      ok: false,
      refusals: [`the lock has more than ${limits.graphPackages} packages`],
    };
  }
  for (const pkg of packages) {
    // The same checks a resolve made, again under this release's rules:
    // an approval never makes a package the platform refuses usable.
    // oxlint-disable-next-line no-await-in-loop
    const inspection = await inspectPackage(pkg, limits);
    const refusals = [
      ...inspection.refusals,
      ...lockEdgeRefusals(lock, pkg.key, inspection),
    ];
    if (refusals.length > 0) {
      return {
        ok: false,
        refusals: refusals.map((reason) => `${pkg.key}: ${reason}`),
      };
    }
    extractedBytes += inspection.bytes;
    if (extractedBytes > limits.graphExtractedBytes) {
      return {
        ok: false,
        refusals: [
          `the packages unpack to more than ${limits.graphExtractedBytes} bytes`,
        ],
      };
    }
    let extracted: Awaited<ReturnType<typeof extractTarball>>;
    try {
      // oxlint-disable-next-line no-await-in-loop
      extracted = await extractTarball(pkg.tarball, limits, isBuildable);
    } catch (error) {
      if (error instanceof TarballRefusedError) {
        return { ok: false, refusals: [`${pkg.key}: ${error.message}`] };
      }
      throw error;
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(utf8.decode(extracted.files.get("package.json")));
    } catch {
      manifest = undefined;
    }
    if (
      typeof manifest !== "object" ||
      manifest === null ||
      Array.isArray(manifest)
    ) {
      return {
        ok: false,
        refusals: [`${pkg.key}: its package.json can't be read`],
      };
    }
    const shape = manifestShapeRefusal(manifest);
    if (shape !== undefined) {
      return { ok: false, refusals: [`${pkg.key}: ${shape}`] };
    }
    unpacked.set(pkg.key, {
      files: extracted.files,
      manifest: Object.fromEntries(Object.entries(manifest)),
    });
    files += extracted.files.size;
    for (const file of extracted.files.values()) {
      bytes += file.byteLength;
    }
  }
  return { ok: true, unpacked, files, bytes };
};

/** One target's build, its refusals as they came. */
const buildUncapped = async (
  request: BuildRequest,
  wasmModule: WebAssembly.Module
): Promise<PackageBuildAnswer> => {
  const { lock, target, limits } = request;
  const conditions = lock.targets[target]?.conditions;
  if (conditions === undefined) {
    return {
      ok: false,
      refusals: [`the lock has no ${target} target`],
    };
  }
  const unpacked = await unpackAll(request);
  if (!unpacked.ok) {
    return unpacked;
  }
  const initializing = Date.now();
  await startEsbuild(wasmModule);
  const building = Date.now();
  const bundled = await bundle({
    lock,
    target,
    packages: unpacked.unpacked,
  });
  const built = Date.now();
  if (!bundled.ok) {
    return { ok: false, refusals: bundled.refusals.slice(0, 50) };
  }
  let artifactBytes = 0;
  const files: PackageArtifact["files"] = {};
  for (const [path, bytes] of bundled.files) {
    artifactBytes += bytes.byteLength;
    // oxlint-disable-next-line no-await-in-loop
    const digest = await sha256(bytes);
    files[path] = {
      sha256: digest,
      bytes: bytes.byteLength,
      type: typeOf(path),
    };
  }
  if (artifactBytes > limits.artifactBytes) {
    return {
      ok: false,
      refusals: [
        `the ${target} artifact is ${artifactBytes} bytes, more than the ${limits.artifactBytes} an artifact may be`,
      ],
    };
  }
  return {
    ok: true,
    artifact: {
      target,
      conditions,
      entries: bundled.entries,
      imports: bundled.imports,
      files,
    },
    files: Object.fromEntries(bundled.files),
    stats: {
      initializeMs: building - initializing,
      buildMs: built - building,
      wasmMemoryBytes: wasmMemory?.buffer.byteLength ?? 0,
      inputFiles: unpacked.files,
      inputBytes: unpacked.bytes,
    },
  };
};

/** Most refusals one build reports, and how long each may be. */
const maxRefusals = 50;
const maxRefusalLength = 500;

const capped = (text: string): string =>
  text.length > maxRefusalLength
    ? `${text.slice(0, maxRefusalLength - 1)}…`
    : text;

/**
 * Builds one target of an approved lock: the artifact, or why not, every
 * reason cut to what core takes (esbuild's own messages can be long).
 */
export const buildTarget = async (
  request: BuildRequest,
  wasmModule: WebAssembly.Module
): Promise<PackageBuildAnswer> => {
  const answer = await buildUncapped(request, wasmModule);
  return answer.ok
    ? answer
    : {
        ok: false,
        refusals: answer.refusals.slice(0, maxRefusals).map(capped),
      };
};
