/**
 * What one npm tarball needs, read without running any of it: unpacked
 * (tarball.ts), its own package.json read, and every reason Grasp can't
 * use it. Runs in the package builder's isolate.
 *
 * Refused, beyond what unpacking refuses:
 *
 * - Bytes other than the integrity hash names: checked again here, so a
 *   corrupted cache can't stand in for the approved package.
 * - A package.json naming another package or version than the one asked
 *   for, or none that can be read.
 * - Install scripts (`preinstall`, `install`, `postinstall`), and a
 *   binding.gyp at its root, which npm builds with node-gyp even without
 *   one: Grasp never runs them.
 * - Native binaries (`*.node`): nothing loads them in a Worker.
 * - Bundled dependencies (`node_modules/` inside the tarball): packages
 *   the graph doesn't name, that no one approved.
 *
 * What its package.json says it depends on is passed back for core to
 * compare with the registry's metadata the graph was resolved from: a
 * tarball that says otherwise is refused there.
 */
import { sha512Integrity } from "@grasp-os/shared/encoding";
import type {
  PackageInspection,
  PackageLimits,
  PackageTarball,
} from "@grasp-os/shared/packages";

import { TarballRefusedError } from "./refused.ts";
import { extractTarball } from "./tarball.ts";

/**
 * The scripts npm can run when installing a package (`prepare` for
 * packages it builds from source).
 */
const installScripts = ["preinstall", "install", "postinstall", "prepare"];

/** The most refusals one package reports, and how long each may be. */
const maxRefusals = 16;
const maxRefusalLength = 200;

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** A record of strings from package.json, or undefined if it is another shape. */
const stringRecord = (value: unknown): Record<string, string> | undefined => {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  return entries.every(([, range]) => typeof range === "string")
    ? Object.fromEntries(entries.map(([name, range]) => [name, String(range)]))
    : undefined;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A record of any values, absent as empty; undefined for another shape. */
const plainRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (value === undefined) {
    return {};
  }
  return isPlainRecord(value) ? value : undefined;
};

/** A list of strings (`os`, `cpu`), absent as empty; undefined otherwise. */
const stringList = (value: unknown): string[] | undefined => {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string")
    ? value
    : undefined;
};

/** The peers `peerDependenciesMeta` marks optional; undefined if malformed. */
const optionalPeersOf = (value: unknown): string[] | undefined => {
  const meta = plainRecord(value);
  if (meta === undefined) {
    return undefined;
  }
  const optional: string[] = [];
  for (const [peer, entry] of Object.entries(meta)) {
    if (!isPlainRecord(entry)) {
      return undefined;
    }
    if (entry.optional === true) {
      optional.push(peer);
    }
  }
  return optional.toSorted();
};

/** Whether `bundleDependencies` says the tarball carries packages. */
const bundles = (value: unknown): boolean =>
  value === true || (Array.isArray(value) && value.length > 0);

/** A refusal, cut to what a review shows. */
const refusal = (text: string): string =>
  text.length > maxRefusalLength
    ? `${text.slice(0, maxRefusalLength - 1)}…`
    : text;

/** The package's own package.json, read as JSON, or undefined. */
const readManifest = (bytes: Uint8Array | undefined): unknown => {
  if (bytes === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(utf8.decode(bytes));
  } catch {
    return undefined;
  }
};

/** What a package.json says that installing it depends on. */
type ManifestFields = NonNullable<PackageInspection["manifest"]> & {
  scripts: Record<string, unknown>;
  platforms: boolean;
  bundlesPackages: boolean;
  gypfile: boolean;
};

/**
 * What a package.json says about installing the package, every field npm
 * reads to install it read whole or not at all: a value of another shape
 * refuses the package (null) rather than hiding the rest.
 */
const manifestFields = (manifest: object): ManifestFields | null => {
  const field = (fieldName: string): unknown =>
    Object.hasOwn(manifest, fieldName)
      ? Reflect.get(manifest, fieldName)
      : undefined;
  const dependencies = stringRecord(field("dependencies"));
  const optionalDependencies = stringRecord(field("optionalDependencies"));
  const peerDependencies = stringRecord(field("peerDependencies"));
  const scripts = plainRecord(field("scripts"));
  const optionalPeers = optionalPeersOf(field("peerDependenciesMeta"));
  const os = stringList(field("os"));
  const cpu = stringList(field("cpu"));
  const named = field("name");
  const versioned = field("version");
  if (
    dependencies === undefined ||
    optionalDependencies === undefined ||
    peerDependencies === undefined ||
    scripts === undefined ||
    optionalPeers === undefined ||
    os === undefined ||
    cpu === undefined ||
    typeof named !== "string" ||
    typeof versioned !== "string"
  ) {
    return null;
  }
  return {
    name: named,
    version: versioned,
    dependencies,
    optionalDependencies,
    peerDependencies,
    optionalPeers,
    scripts,
    platforms: os.length > 0 || cpu.length > 0,
    bundlesPackages:
      bundles(field("bundleDependencies")) ||
      bundles(field("bundledDependencies")),
    gypfile: field("gypfile") === true,
  };
};

/** Inspects one tarball: unpacks it with `limits` and reads what it needs. */
export const inspectPackage = async (
  { key, name, version, integrity, tarball }: PackageTarball,
  limits: PackageLimits
): Promise<PackageInspection> => {
  const refused = (reasons: string[]): PackageInspection => ({
    key,
    bytes: 0,
    entries: 0,
    manifest: null,
    refusals: reasons.map(refusal),
  });
  if ((await sha512Integrity(tarball)) !== integrity) {
    return refused(["its bytes aren't the ones its integrity hash names"]);
  }
  // The first few paths of each, to name: never every one a tarball has.
  const native: string[] = [];
  const bundled: string[] = [];
  const shownPaths = 3;
  let gyp = false;
  let extracted: Awaited<ReturnType<typeof extractTarball>>;
  try {
    extracted = await extractTarball(tarball, limits, (path) => {
      if (path.endsWith(".node") && native.length < shownPaths) {
        native.push(path);
      }
      if (
        bundled.length < shownPaths &&
        path.split("/").includes("node_modules")
      ) {
        bundled.push(path);
      }
      gyp ||= path === "binding.gyp";
      return path === "package.json";
    });
  } catch (error) {
    if (error instanceof TarballRefusedError) {
      return refused([error.message]);
    }
    throw error;
  }
  const { bytes, entries } = extracted;
  const manifest = readManifest(extracted.files.get("package.json"));
  if (typeof manifest !== "object" || manifest === null) {
    return { ...refused(["its package.json can't be read"]), bytes, entries };
  }
  const fields = manifestFields(manifest);
  if (fields === null) {
    return { ...refused(["its package.json can't be read"]), bytes, entries };
  }
  const { scripts, platforms, bundlesPackages, gypfile, ...stated } = fields;
  const reasons: string[] = [];
  if (stated.name !== name || stated.version !== version) {
    reasons.push(
      `its package.json says it is ${stated.name}@${stated.version}, not ${name}@${version}`
    );
  }
  // Each install script by name, whatever its value or the others'.
  const scripted = installScripts.filter((script) =>
    Object.hasOwn(scripts, script)
  );
  if (scripted.length > 0) {
    reasons.push(`it has install scripts: ${scripted.join(", ")}`);
  }
  if (gyp || gypfile) {
    reasons.push("it builds native code (binding.gyp)");
  }
  if (native.length > 0) {
    reasons.push(`it ships native binaries: ${native.join(", ")}`);
  }
  if (platforms) {
    reasons.push("it runs only on some operating systems or processors");
  }
  if (bundled.length > 0) {
    reasons.push(
      `it bundles packages the graph doesn't name: ${bundled.join(", ")}`
    );
  } else if (bundlesPackages) {
    reasons.push("it bundles packages the graph doesn't name");
  }
  return {
    key,
    bytes,
    entries,
    manifest: stated,
    refusals: reasons.slice(0, maxRefusals).map(refusal),
  };
};
