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
//   is cut off by a timeout. A package's metadata can be tens of MiB: its
//   chunks are let go as they arrive, its bytes once decoded and its text
//   once parsed (`readTextCapped`), and core asks for at most two at once
//   (`metadataConcurrency`, resolve.ts), so a resolve stays within this
//   isolate's memory.
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
 * Each chunk of the body, read up to `maxBytes` and handed to `take` as it
 * arrives: past that, the read is cancelled and the package refused as too
 * large. Counted as it arrives, never by what Content-Length says.
 */
const readEachCapped = async (
  response: Response,
  maxBytes: number,
  take: (chunk: Uint8Array) => void
): Promise<number> => {
  const { body } = response;
  if (body === null) {
    return 0;
  }
  const reader = body.getReader();
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
    try {
      take(value);
    } catch (error) {
      // oxlint-disable-next-line no-await-in-loop
      await reader.cancel();
      throw error;
    }
  }
  return total;
};

/** The body's bytes, read up to `maxBytes`: for a tarball, hashed whole. */
const readCapped = async (
  response: Response,
  maxBytes: number
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  const total = await readEachCapped(response, maxBytes, (chunk) => {
    chunks.push(chunk);
  });
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks.splice(0)) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
};

/**
 * The most bytes of metadata this isolate holds at once, across every
 * request it serves: a package's metadata can be tens of MiB, and reading
 * one holds its bytes, then its text and what that parses to, about twice
 * its bytes at the peak. Connect's isolate has 128 MB and also serves the
 * connectors' calls, so metadata reads together take at most 40 MiB of
 * buffers: one read of the largest metadata taken (24 MiB, its buffer
 * growing from 16 MiB to 24 holds both for a moment), or a few smaller
 * ones. A read past that is refused at once as busy, never waited for
 * (`package.registry_busy`, which core retries after a pause). Each read
 * reserves the size its answer declares, then what its buffer grows to,
 * and gives it all back when it ends, however it ends. Nothing here waits
 * on another request: workerd doesn't let one request's promise settle
 * another's.
 */
const metadataBudgetBytes = 40 * 1024 * 1024;

/** Bytes of metadata reserved in this isolate now (`reserveMetadata`). */
let reservedMetadataBytes = 0;

/** One read's share of {@link metadataBudgetBytes}. */
interface Reservation {
  /** Grows the share to `bytes`, or refuses as busy. */
  grow: (bytes: number) => void;
  /** Gives the share back; once is enough, twice is harmless. */
  release: () => void;
}

/** A share of the budget of `bytes` to start with, or `package.registry_busy`. */
const reserveMetadata = (bytes: number, what: string): Reservation => {
  let held = 0;
  const grow = (wanted: number): void => {
    if (wanted <= held) {
      return;
    }
    if (reservedMetadataBytes - held + wanted > metadataBudgetBytes) {
      log.warn("npm.busy", {
        package: what,
        reserved: reservedMetadataBytes,
        wanted,
      });
      throw packageErrors.create("package.registry_busy");
    }
    reservedMetadataBytes += wanted - held;
    held = wanted;
  };
  grow(bytes);
  return {
    grow,
    release: () => {
      reservedMetadataBytes -= held;
      held = 0;
    },
  };
};

/** The first buffer a body of text is read into; it doubles as it fills. */
const firstTextBufferBytes = 1024 * 1024;

/**
 * The body as UTF-8 text, read up to `maxBytes`. Each chunk is copied into
 * one buffer as it arrives and let go, the buffer doubling when full, and
 * the buffer is let go once decoded, so the text is parsed with no bytes
 * of the body held. Measured on @types/node's metadata (10.7 MiB), this
 * holds about two thirds of what keeping every chunk, joining them and
 * decoding the whole did; decoding each chunk as it arrives held more, as
 * its pieces of text and their join are both held at the end. Text that
 * isn't UTF-8 is unreadable (`package.registry_unavailable`).
 */
const readTextCapped = async (
  response: Response,
  maxBytes: number,
  what: string,
  reservation: Reservation
): Promise<string> => {
  const first = Math.min(firstTextBufferBytes, maxBytes);
  reservation.grow(first);
  let buffer = new Uint8Array(first);
  let used = 0;
  await readEachCapped(response, maxBytes, (chunk) => {
    if (used + chunk.byteLength > buffer.byteLength) {
      const size = Math.min(
        Math.max(buffer.byteLength * 2, used + chunk.byteLength),
        maxBytes
      );
      // The old buffer and the new are both held as one is copied over.
      reservation.grow(buffer.byteLength + size);
      const grown = new Uint8Array(size);
      grown.set(buffer.subarray(0, used));
      buffer = grown;
    }
    buffer.set(chunk, used);
    used += chunk.byteLength;
  });
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      buffer.subarray(0, used)
    );
  } catch {
    log.warn("npm.unreadable", { package: what });
    throw packageErrors.create("package.registry_unavailable");
  }
};

/**
 * One answer of the registry's at `start`, following redirects within the
 * registry only: a successful one, its body not yet read. `what` names it
 * in the logs: a package name, which is public.
 */
const fetchFromRegistry = async (
  start: URL,
  accept: string,
  what: string
): Promise<Response> => {
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
    return response;
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

/**
 * A version's publication time as the registry's `time` gives it: an ISO
 * 8601 time, or null for anything else (missing, or not a time). The one
 * check both passing a time on and ranking versions by it use.
 */
const publicationTime = (value: unknown): string | null =>
  typeof value === "string" && z.iso.datetime().safeParse(value).success
    ? value
    : null;

const toVersion = (
  entry: z.infer<typeof registryVersionSchema>,
  publishedAt: string | null
): NpmVersion => ({
  version: entry.version,
  publishedAt: publicationTime(publishedAt),
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
 * The `registryLimits.versions` keys ranked highest by `rank` (newest
 * first), chosen in one pass with a min-heap of at most that many: never
 * the whole list sorted.
 */
const newestKeys = (
  keys: readonly string[],
  rank: (key: string) => number
): Set<string> => {
  const limit = registryLimits.versions;
  if (keys.length <= limit) {
    return new Set(keys);
  }
  const heap: { key: string; at: number }[] = [];
  const less = (a: number, b: number): boolean =>
    (heap[a]?.at ?? 0) < (heap[b]?.at ?? 0);
  const swap = (a: number, b: number): void => {
    const first = heap[a];
    const second = heap[b];
    if (first !== undefined && second !== undefined) {
      heap[a] = second;
      heap[b] = first;
    }
  };
  const down = (from: number): void => {
    let at = from;
    for (;;) {
      const left = at * 2 + 1;
      const right = left + 1;
      let smallest = at;
      if (left < heap.length && less(left, smallest)) {
        smallest = left;
      }
      if (right < heap.length && less(right, smallest)) {
        smallest = right;
      }
      if (smallest === at) {
        return;
      }
      swap(at, smallest);
      at = smallest;
    }
  };
  for (const key of keys) {
    const at = rank(key);
    if (heap.length < limit) {
      heap.push({ key, at });
      for (let child = heap.length - 1; child > 0;) {
        const parent = Math.floor((child - 1) / 2);
        if (!less(child, parent)) {
          break;
        }
        swap(child, parent);
        child = parent;
      }
    } else if (at > (heap[0]?.at ?? Number.NEGATIVE_INFINITY)) {
      heap[0] = { key, at };
      down(0);
    }
  }
  return new Set(heap.map(({ key }) => key));
};

/** `text` as JSON, or `package.registry_unavailable`. */
const parsedJson = (text: string, name: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    log.warn("npm.unreadable", { package: name });
    throw packageErrors.create("package.registry_unavailable");
  }
};

/** `name`'s metadata from `response`, within `reservation`. */
const parsedMetadata = async (
  name: string,
  response: Response,
  reservation: Reservation
): Promise<NpmMetadata> => {
  // The text is held only while it is parsed, never beside the result.
  const parsed = parsedJson(
    await readTextCapped(
      response,
      registryLimits.metadataBytes,
      name,
      reservation
    ),
    name
  );
  const packument = packumentSchema.safeParse(parsed);
  if (!packument.success || packument.data.name !== name) {
    log.warn("npm.unreadable", { package: name });
    throw packageErrors.create("package.registry_unavailable");
  }
  const { versions, time } = packument.data;
  const published = (key: string): string | null =>
    publicationTime(time?.[key]);
  // Ranked by the instant a valid time names; a version without one ranks
  // last, so it never takes the place of one the registry dates.
  const rank = (key: string): number => {
    const at = published(key);
    return at === null ? Number.NEGATIVE_INFINITY : Date.parse(at);
  };
  // Only the newest versions by publication are read at all: chosen while
  // scanning the keys, in a heap of at most that many, before any version
  // is parsed. The registry's order is kept for those passed on.
  const chosen = newestKeys(Object.keys(versions), rank);
  const kept: NpmVersion[] = [];
  let dropped = 0;
  for (const [key, value] of Object.entries(versions)) {
    if (!chosen.has(key)) {
      continue;
    }
    const entry = registryVersionSchema.safeParse(value);
    if (
      entry.success &&
      entry.data.name === name &&
      entry.data.version === key
    ) {
      kept.push(toVersion(entry.data, published(key)));
    } else {
      dropped += 1;
    }
  }
  if (dropped > 0) {
    log.info("npm.versions_dropped", { package: name, dropped });
  }
  return npmMetadataSchema.parse({ name, versions: kept });
};

/** `name`'s metadata, read and parsed down to what is passed on. */
const readMetadata = async (name: string): Promise<NpmMetadata> => {
  const response = await fetchFromRegistry(
    metadataUrl(name),
    "application/json",
    name
  );
  const declared = Number(response.headers.get("content-length") ?? 0);
  let reservation: Reservation | undefined;
  try {
    reservation = reserveMetadata(
      Number.isSafeInteger(declared) && declared > 0
        ? Math.min(declared, registryLimits.metadataBytes)
        : 0,
      name
    );
    return await parsedMetadata(name, response, reservation);
  } catch (error) {
    // Refused before its body was read (busy as its first buffer is
    // reserved, say): the registry's read is let go, not left open. A
    // body being read was cancelled by its reader (`readEachCapped`).
    if (response.body !== null && !response.body.locked) {
      await response.body.cancel();
    }
    throw error;
  } finally {
    reservation?.release();
  }
};

/**
 * A package's metadata, from the registry, as core resolves with it. A
 * version whose metadata can't be read as npm's (a name or range that
 * isn't one, another package's name, a key that isn't its version) is
 * left out: it can't be resolved to.
 */
export const npmMetadata = async (input: unknown): Promise<NpmMetadata> => {
  const name = packageErrors.parse("package.invalid", nameSchema, input);
  return await readMetadata(name);
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
  const response = await fetchFromRegistry(
    tarballUrl(name, version),
    "application/octet-stream",
    name
  );
  const bytes = await readCapped(response, registryLimits.archiveBytes);
  if ((await sha512Integrity(bytes)) !== integrity) {
    log.warn("npm.integrity_mismatch", { package: name, version });
    throw packageErrors.create("package.integrity_mismatch");
  }
  return bytes;
};
