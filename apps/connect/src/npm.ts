import {
  exactVersionSchema,
  npmRegistryOrigin,
  packageNameSchema,
} from "@grasp-os/shared/dependencies";
import { sha512Integrity } from "@grasp-os/shared/encoding";
import { log } from "@grasp-os/shared/log";
import {
  npmMetadataSchema,
  npmTarballRequestSchema,
  packageErrors,
  registryLimits,
} from "@grasp-os/shared/packages";
import type { NpmMetadata, NpmVersion } from "@grasp-os/shared/packages";
import { z } from "zod";

// The npm registry, as core reaches it through connect (the
// PackageRegistry adapter for npmjs). Every package Grasp ever unpacks
// comes through here: its metadata, then one version's tarball by the
// integrity hash core asks for. What could go wrong, and what stops it:
//
// - Being sent elsewhere. Only https://registry.npmjs.org is asked, at a
//   path built here from a checked name and version, never from a URL in
//   the metadata (`dist.tarball`) or anything core sends. Redirects aren't
//   followed by fetch: one is followed here only to the registry's own
//   origin, over HTTPS, without credentials in the URL, a few times at
//   most; any other is refused. Connect's `global_fetch_strictly_public`
//   keeps a public name that resolves to a private address unreachable.
// - Other bytes than asked for. A tarball is passed on only when its
//   SHA-512 is the integrity hash core named, which comes from the
//   registry's metadata when resolving and from the approved lock after.
//   Versions with only a SHA-1 have no integrity Grasp takes.
// - Too much. Bodies are counted as they arrive (decompressed), never by
//   what Content-Length says, and cut off at the limits; a slow registry
//   is cut off by a timeout.
// - Credentials. None is sent: the public registry needs none, and a
//   private registry would get its own adapter with credentials held here,
//   never in core, an agent or App code.
// - Package text. A README, description or script body is never passed
//   on; licence and ranges are bounded strings, data only.

const registry = new URL(npmRegistryOrigin);

/** How long one request to the registry may take. */
const requestTimeoutMs = 30_000;

const redirectStatuses: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

/** Where a package's metadata is: a scope's slash encoded, as npm asks. */
const metadataUrl = (name: string): URL =>
  new URL(`/${name.replace("/", "%2f")}`, registry);

/** Where one version's tarball is, as the registry names its tarballs. */
const tarballUrl = (name: string, version: string): URL => {
  const base = name.slice(name.indexOf("/") + 1);
  return new URL(`/${name}/-/${base}-${version}.tgz`, registry);
};

/** Whether a redirect leads back to the registry itself, as it was asked. */
const withinRegistry = (url: URL): boolean =>
  url.protocol === registry.protocol &&
  url.host === registry.host &&
  url.username === "" &&
  url.password === "";

/** Where a redirect leads, if it says so readably. */
const locationOf = (response: Response, from: URL): URL | undefined => {
  const location = response.headers.get("location");
  if (location === null) {
    return undefined;
  }
  try {
    return new URL(location, from);
  } catch {
    return undefined;
  }
};

/**
 * The body, read up to `maxBytes`: past that, the read is cancelled and
 * the package refused as too large. Counted as it arrives.
 */
const readCapped = async (
  response: Response,
  maxBytes: number
): Promise<Uint8Array> => {
  const { body } = response;
  if (body === null) {
    return new Uint8Array();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<unknown>;
    try {
      // Each chunk is read in turn: the count decides whether to read on.
      // oxlint-disable-next-line no-await-in-loop
      chunk = await reader.read();
    } catch {
      // The timeout, or the connection reset, mid-body.
      throw packageErrors.create("package.registry_unavailable");
    }
    if (chunk.done) {
      break;
    }
    const value: unknown = chunk.value;
    if (!(value instanceof Uint8Array)) {
      // oxlint-disable-next-line no-await-in-loop
      await reader.cancel();
      throw packageErrors.create("package.registry_unavailable");
    }
    total += value.byteLength;
    if (total > maxBytes) {
      // oxlint-disable-next-line no-await-in-loop
      await reader.cancel();
      throw packageErrors.create("package.too_large", { limit: maxBytes });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
};

/**
 * One answer of the registry's at `start`, following redirects within the
 * registry only, read up to `maxBytes`. `what` names it in the logs: a
 * package name, which is public.
 */
const fetchFromRegistry = async (
  start: URL,
  accept: string,
  maxBytes: number,
  what: string
): Promise<Uint8Array> => {
  let url = start;
  for (let hop = 0; ; hop += 1) {
    let response: Response;
    try {
      // One request at a time: each redirect decides the next.
      // oxlint-disable-next-line no-await-in-loop
      response = await fetch(url, {
        redirect: "manual",
        headers: { accept },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      log.warn("npm.unreachable", { package: what });
      throw packageErrors.create("package.registry_unavailable");
    }
    if (redirectStatuses.has(response.status)) {
      // oxlint-disable-next-line no-await-in-loop
      await response.body?.cancel();
      const next = locationOf(response, url);
      if (
        next === undefined ||
        !withinRegistry(next) ||
        hop >= registryLimits.redirects
      ) {
        // The target isn't logged: a host the registry made up could be
        // anything.
        log.warn("npm.redirect_refused", { package: what, hop });
        throw packageErrors.create("package.redirect_refused");
      }
      url = next;
      continue;
    }
    if (response.status === 404) {
      // oxlint-disable-next-line no-await-in-loop
      await response.body?.cancel();
      throw packageErrors.create("package.not_found");
    }
    if (!response.ok) {
      // oxlint-disable-next-line no-await-in-loop
      await response.body?.cancel();
      log.warn("npm.failed", { package: what, status: response.status });
      throw packageErrors.create("package.registry_unavailable");
    }
    // oxlint-disable-next-line no-await-in-loop
    return await readCapped(response, maxBytes);
  }
};

/** A name as the registry gives it, or a reason to drop what has it. */
const nameSchema = packageNameSchema;

/** Text the registry gives for something short, cut to `max`. */
const shortText = (max: number) =>
  z.string().transform((text) => text.slice(0, max));

/** Ranges by name: every name an npm name, every range a short string. */
const rangesSchema = z
  .record(nameSchema, z.string().max(registryLimits.textLength))
  .refine((ranges) => Object.keys(ranges).length <= registryLimits.edges);

/**
 * `schema`'s value, or undefined for anything else: for fields a version
 * may have written in shapes npm itself ignores, which shouldn't cost the
 * whole version.
 */
const lenient = <Schema extends z.ZodType>(schema: Schema) =>
  z
    .unknown()
    .transform((value): z.output<Schema> | undefined => {
      const parsed = schema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    })
    .optional();

/** A licence in any of the shapes packages have written it. */
const licenseSchema = z.union([
  shortText(128),
  z.looseObject({ type: shortText(128) }).transform(({ type }) => type),
]);

/** The install scripts npm runs when it installs a package. */
const installScriptNames = ["preinstall", "install", "postinstall"] as const;

/**
 * One version as the registry's metadata has it: only the fields kept are
 * read, and the rest (README, scripts' bodies, maintainers) is ignored.
 */
const registryVersionSchema = z.looseObject({
  name: nameSchema,
  version: exactVersionSchema,
  license: lenient(licenseSchema),
  dependencies: rangesSchema.optional(),
  optionalDependencies: rangesSchema.optional(),
  peerDependencies: rangesSchema.optional(),
  peerDependenciesMeta: lenient(
    z.record(z.string(), z.looseObject({ optional: z.boolean().optional() }))
  ),
  bundleDependencies: z.unknown().optional(),
  bundledDependencies: z.unknown().optional(),
  scripts: lenient(z.record(z.string(), z.unknown())),
  hasInstallScript: lenient(z.boolean()),
  gypfile: lenient(z.boolean()),
  os: lenient(z.array(shortText(32)).max(32)),
  cpu: lenient(z.array(shortText(32)).max(32)),
  deprecated: z.unknown().optional(),
  dist: z.looseObject({ integrity: z.string().optional() }),
});

const integrityPattern = /^sha512-[A-Za-z0-9+/]{86}==$/u;

/** Whether a version bundles dependencies, in any way npm reads the field. */
const bundles = (value: unknown): boolean =>
  value === true || (Array.isArray(value) && value.length > 0);

/** The install scripts a version's metadata says it has. */
const installScriptsOf = (
  scripts: Record<string, unknown> | undefined,
  hasInstallScript: boolean | undefined
): string[] => {
  const named = installScriptNames.filter(
    (script) => typeof scripts?.[script] === "string"
  );
  return named.length === 0 && hasInstallScript === true
    ? ["hasInstallScript"]
    : named;
};

const toVersion = (
  entry: z.infer<typeof registryVersionSchema>,
  publishedAt: string | undefined
): NpmVersion => ({
  version: entry.version,
  publishedAt:
    publishedAt !== undefined && z.iso.datetime().safeParse(publishedAt).success
      ? publishedAt
      : null,
  integrity:
    entry.dist.integrity !== undefined &&
    integrityPattern.test(entry.dist.integrity)
      ? entry.dist.integrity
      : null,
  license:
    entry.license === undefined || entry.license === "" ? null : entry.license,
  dependencies: entry.dependencies ?? {},
  optionalDependencies: entry.optionalDependencies ?? {},
  peerDependencies: entry.peerDependencies ?? {},
  optionalPeers: Object.entries(entry.peerDependenciesMeta ?? {})
    .filter(
      ([peer, meta]) =>
        meta.optional === true && nameSchema.safeParse(peer).success
    )
    .map(([peer]) => peer)
    .slice(0, registryLimits.edges),
  bundlesDependencies:
    bundles(entry.bundleDependencies) || bundles(entry.bundledDependencies),
  installScripts: installScriptsOf(entry.scripts, entry.hasInstallScript),
  gypfile: entry.gypfile === true,
  os: entry.os ?? [],
  cpu: entry.cpu ?? [],
  deprecated:
    typeof entry.deprecated === "string" && entry.deprecated.length > 0,
});

const packumentSchema = z.looseObject({
  name: z.string(),
  versions: z.record(z.string(), z.unknown()),
  time: lenient(z.record(z.string(), z.unknown())),
});

/**
 * A package's metadata, from the registry, as core resolves with it. A
 * version whose metadata can't be read as npm's (a name or range that
 * isn't one, another package's name, a key that isn't its version) is
 * left out: it can't be resolved to.
 */
export const npmMetadata = async (input: unknown): Promise<NpmMetadata> => {
  const name = packageErrors.parse("package.invalid", nameSchema, input);
  const bytes = await fetchFromRegistry(
    metadataUrl(name),
    "application/json",
    registryLimits.metadataBytes,
    name
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)
    );
  } catch {
    log.warn("npm.unreadable", { package: name });
    throw packageErrors.create("package.registry_unavailable");
  }
  const packument = packumentSchema.safeParse(parsed);
  if (!packument.success || packument.data.name !== name) {
    log.warn("npm.unreadable", { package: name });
    throw packageErrors.create("package.registry_unavailable");
  }
  const { versions, time } = packument.data;
  const kept: NpmVersion[] = [];
  let dropped = 0;
  for (const [key, value] of Object.entries(versions)) {
    const entry = registryVersionSchema.safeParse(value);
    if (
      entry.success &&
      entry.data.name === name &&
      entry.data.version === key
    ) {
      const published = time?.[key];
      kept.push(
        toVersion(
          entry.data,
          typeof published === "string" ? published : undefined
        )
      );
    } else {
      dropped += 1;
    }
  }
  if (dropped > 0) {
    log.info("npm.versions_dropped", { package: name, dropped });
  }
  // The newest by publication, when there are more than are passed on.
  const newest =
    kept.length > registryLimits.versions
      ? kept
          .toSorted((a, b) =>
            (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")
          )
          .slice(0, registryLimits.versions)
      : kept;
  return npmMetadataSchema.parse({ name, versions: newest });
};

/**
 * One version's tarball from the registry, passed on only when its SHA-512
 * is the integrity hash asked for.
 */
export const npmTarball = async (input: unknown): Promise<Uint8Array> => {
  const { name, version, integrity } = packageErrors.parse(
    "package.invalid",
    npmTarballRequestSchema,
    input
  );
  const bytes = await fetchFromRegistry(
    tarballUrl(name, version),
    "application/octet-stream",
    registryLimits.archiveBytes,
    name
  );
  if ((await sha512Integrity(bytes)) !== integrity) {
    log.warn("npm.integrity_mismatch", { package: name, version });
    throw packageErrors.create("package.integrity_mismatch");
  }
  return bytes;
};
