/**
 * The release manifest: the contract between CI, which builds core and
 * connect once per commit (scripts/release), and the console, which imports
 * each release and deploys those exact bytes into client accounts.
 *
 * Blobs are content-addressed, in two schemes on purpose:
 * - Worker modules and D1 migrations by their full SHA-256 (hex): our own
 *   scheme, for deduplication in R2 and for checking that what the console
 *   deploys is what CI built.
 * - Static assets by the content key of Cloudflare's assets-upload API:
 *   SHA-256 of base64(contents) plus the file's extension, hex, cut to 32
 *   characters. The API treats it as an opaque key per file (Wrangler
 *   computes the same shape with BLAKE3), so CI and the console only have to
 *   agree with each other, byte for byte.
 *
 * Account-specific values in a Worker's bindings are placeholders the
 * console fills in for the Worker it deploys:
 *
 *   $D1_<BINDING>_ID   the id of the D1 database that binding names
 *
 * The placeholder list is closed: the console refuses a `$` token it doesn't
 * know, so the generator and the console change together, behind
 * MANIFEST_VERSION.
 *
 * Nothing but Web APIs, so CI (Node) and the console (workerd) verify a
 * release with the same code.
 */
import { z } from "zod";

import { toHex } from "./encoding.ts";

/** The manifest shape the console must understand (see the header comment). */
export const MANIFEST_VERSION = 2;

/** A binding's name, as wrangler.jsonc and the Workers API take it. */
export const bindingNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/u);

/** Worker observability settings that mean the same in every account. */
export const observabilitySchema = z.strictObject({
  enabled: z.boolean().optional(),
  redact_query_string: z.boolean().optional(),
  logs: z.strictObject({ invocation_logs: z.boolean().optional() }).optional(),
  traces: z.strictObject({ enabled: z.boolean().optional() }).optional(),
});

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const assetHash = z.string().regex(/^[0-9a-f]{32}$/u);
const size = z.int().nonnegative();

const fileRef = z.strictObject({
  name: z.string(),
  sha256,
  size,
  r2Key: z.string(),
});

/**
 * A name the Workers API takes for a Worker, a Workflow or a D1 database
 * in a client account: lowercase letters, digits and dashes, at most 63.
 */
export const workerNameSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u);

/** The placeholder a D1 binding's id is in the manifest, filled in per account. */
export const d1IdPlaceholder = (binding: string): string => `$D1_${binding}_ID`;

// `r<run>-<sha7>` from CI, `dev-<time>` locally. It becomes an R2 prefix, so
// nothing else is allowed in it.
const RELEASE_ID = /^(?:r\d{6,}-[0-9a-f]{7}|dev-[0-9a-z]+)$/u;

/** A release's id: `r<run6>-<sha7>` from CI, `dev-<time>` locally. */
export const releaseIdSchema = z.string().regex(RELEASE_ID);

// Platform limits and the evidence for raising one.
//
// A platform limit (platform-limits.ts) is raised only by a release, and
// only with evidence CI produced for it: a capacity run on the release's
// own commit, for a runtime profile, and the security review of the change
// (its pull request and the CODEOWNERS approval). Never a success report
// from a client's core. Three places hold a release to it, with these
// rules:
// - CI's build, which fails before publishing a release whose raises it
//   has no evidence for (scripts/release).
// - The console's import (`verifyLimitEvidence`): the evidence is exactly
//   the manifest's own raises over the release before it, each entry
//   naming the manifest's commit and release id.
// - Every deploy of a release to a client (`uncoveredRaise`): a limit
//   higher than what the client runs needs evidence for the client's
//   profile, from the console's own records rather than the manifest's
//   word about its predecessor.
// None of this stops someone who can write the releases bucket: they can
// write a consistent manifest with forged evidence, as they can forge the
// release. Binding the manifest to its producer (a signature checked on
// import, GRA-891's pattern) closes that, and these checks run unchanged
// after it.

const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);

/**
 * Where a release runs, as core's `RUNTIME_PROFILE` names it: Cloudflare,
 * or plain workerd on premises. Capacity holds per profile.
 */
export const runtimeProfiles = ["cloudflare", "workerd"] as const;
export const runtimeProfileSchema = z.enum(runtimeProfiles);
export type RuntimeProfile = z.infer<typeof runtimeProfileSchema>;

/** A limit's name, as `platformLimits` spells it. */
const limitNameSchema = z.string().regex(/^[a-z][A-Za-z0-9]*$/u);

/** A limit's value, in the unit its name says. */
const limitValueSchema = z.int().nonnegative();

/** Every platform limit of a release, by name. */
export const platformLimitsSchema = z.record(limitNameSchema, limitValueSchema);
export type PlatformLimits = z.infer<typeof platformLimitsSchema>;

/**
 * The release before this one, as CI found it: the last one published, not
 * the parent commit, since a burst of merges can leave a commit
 * unpublished. Null for the first release that records limits.
 */
export const previousReleaseSchema = z
  .strictObject({
    releaseId: releaseIdSchema,
    platformLimits: platformLimitsSchema,
  })
  .nullable();
export type PreviousRelease = z.infer<typeof previousReleaseSchema>;

/** A GitHub login: what CODEOWNERS names. */
const githubLoginSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u);

/**
 * The evidence for one raised limit on one profile. `raisedTo` is the
 * value it vouches for: the release's own, or null when the release drops
 * the limit (unbounded).
 */
export const limitEvidenceSchema = z.strictObject({
  limit: limitNameSchema,
  raisedTo: limitValueSchema.nullable(),
  /** The source: the commit the release was built from. */
  commit: commitSchema,
  /** The candidate: the release it was produced for. */
  releaseId: releaseIdSchema,
  /** The profile it holds for. */
  profile: runtimeProfileSchema,
  /** The CI job that ran the capacity workload. */
  capacityRun: z.strictObject({
    jobId: z.int().positive(),
    commit: commitSchema,
    profile: runtimeProfileSchema,
  }),
  /** The pull request that made the change, and its CODEOWNERS approval. */
  securityReview: z.strictObject({
    pullRequest: z.int().positive(),
    approvedBy: githubLoginSchema,
  }),
});
export type LimitEvidence = z.infer<typeof limitEvidenceSchema>;

/** A limit higher in one release than another: null when it's dropped. */
export interface LimitRaise {
  limit: string;
  raisedTo: number | null;
}

/**
 * The limits `to` raises over `from`: each one higher, and each one `from`
 * has that `to` drops (unbounded). A limit new in `to` is a lower one,
 * from none, so it's no raise.
 */
export const limitRaises = (
  from: PlatformLimits,
  to: PlatformLimits
): LimitRaise[] => {
  const raises: LimitRaise[] = [];
  for (const [limit, before] of Object.entries(from)) {
    const after = Object.hasOwn(to, limit) ? to[limit] : undefined;
    if (after === undefined) {
      raises.push({ limit, raisedTo: null });
    } else if (after > before) {
      raises.push({ limit, raisedTo: after });
    }
  }
  return raises;
};

/** What a release says about its limits, as its manifest has it. */
export type ReleaseLimits = Pick<
  ReleaseManifest,
  | "releaseId"
  | "commit"
  | "platformLimits"
  | "previousRelease"
  | "limitEvidence"
>;

const show = (value: number | null): string =>
  value === null ? "unbounded" : String(value);

/**
 * Throws unless `release`'s evidence is exactly what its raises over the
 * release before it need: at least one entry for each raise, each for the
 * value the release raises it to, and each naming the release's own commit
 * and id, its capacity run on that commit and for its profile. An entry for
 * a limit it doesn't raise, or a second one for a limit and profile, is
 * refused too: evidence is produced for one release, never carried along.
 */
export const verifyLimitEvidence = (release: ReleaseLimits): void => {
  const raises = new Map(
    limitRaises(
      release.previousRelease?.platformLimits ?? release.platformLimits,
      release.platformLimits
    ).map(({ limit, raisedTo }) => [limit, raisedTo])
  );
  const seen = new Set<string>();
  for (const entry of release.limitEvidence) {
    const what = `The evidence for ${entry.limit} on ${entry.profile}`;
    if (
      entry.commit !== release.commit ||
      entry.capacityRun.commit !== release.commit
    ) {
      throw new Error(
        `${what} is for commit ${entry.commit === release.commit ? entry.capacityRun.commit : entry.commit}, not the release's ${release.commit}`
      );
    }
    if (entry.releaseId !== release.releaseId) {
      throw new Error(
        `${what} is for release ${entry.releaseId}, not ${release.releaseId}`
      );
    }
    if (entry.capacityRun.profile !== entry.profile) {
      throw new Error(
        `${what} names a capacity run on ${entry.capacityRun.profile}`
      );
    }
    const key = `${entry.limit} ${entry.profile}`;
    if (seen.has(key)) {
      throw new Error(`${what} is given twice`);
    }
    seen.add(key);
    if (!raises.has(entry.limit)) {
      throw new Error(`${what} is for a limit the release doesn't raise`);
    }
    const raisedTo = raises.get(entry.limit) ?? null;
    if (entry.raisedTo !== raisedTo) {
      throw new Error(
        `${what} vouches for ${show(entry.raisedTo)}, but the release raises it to ${show(raisedTo)}`
      );
    }
  }
  for (const [limit, raisedTo] of raises) {
    if (!release.limitEvidence.some((entry) => entry.limit === limit)) {
      throw new Error(
        `Release ${release.releaseId} raises ${limit} to ${show(raisedTo)} without capacity and security evidence`
      );
    }
  }
};

/** Whether `entry` vouches for `raise` on `profile`, by itself. */
const covers = (
  entry: LimitEvidence,
  raise: LimitRaise,
  profile: RuntimeProfile
): boolean =>
  entry.limit === raise.limit &&
  entry.profile === profile &&
  (entry.raisedTo === null ||
    (raise.raisedTo !== null && entry.raisedTo >= raise.raisedTo));

/**
 * Whether `evidence` vouches for `raise` on `profile`: the release that
 * raised the limit last (the latest with an entry for it; only a release
 * that raises a limit carries one) has an entry for the profile that
 * raised it at least as far, a dropped limit only one that drops it. The
 * last raise, not any: a limit lowered and raised again needs evidence for
 * the code that raised it again.
 */
const vouchedFor = (
  evidence: readonly LimitEvidence[],
  raise: LimitRaise,
  profile: RuntimeProfile
): boolean => {
  const forLimit = evidence.filter((entry) => entry.limit === raise.limit);
  const last = forLimit.at(-1)?.releaseId;
  return forLimit.some(
    (entry) => entry.releaseId === last && covers(entry, raise, profile)
  );
};

/**
 * The first raise from `from` to `to` that `evidence` doesn't vouch for
 * on `profile` (`vouchedFor`), or undefined when it vouches for each.
 * `evidence` is what the releases a client passes through on the way to
 * `to` carry, oldest release first, each already checked to be its own
 * (`verifyLimitEvidence`).
 */
export const uncoveredRaise = (
  from: PlatformLimits,
  to: PlatformLimits,
  evidence: readonly LimitEvidence[],
  profile: RuntimeProfile
): LimitRaise | undefined =>
  limitRaises(from, to).find((raise) => !vouchedFor(evidence, raise, profile));

const workerEntrySchema = z.strictObject({
  /** The Worker's name in every client account. */
  name: workerNameSchema,
  /** The entry module, one of `modules`. */
  mainModule: z.string(),
  modules: z.array(
    fileRef.extend({ type: z.enum(["esm", "text", "wasm", "data"]) })
  ),
  compatibilityFlags: z.array(z.string()),
  /** Script-upload API bindings, account-specific values as placeholders. */
  bindings: z.array(
    z
      .looseObject({ type: z.string(), name: bindingNameSchema })
      // A Workflow is created by its name in the account.
      .refine(
        (binding) =>
          binding.type !== "workflow" ||
          workerNameSchema.safeParse(binding.workflow_name).success,
        "A Workflow binding names its Workflow as a Worker name"
      )
  ),
  /** Each D1 database: created by name, migrated in order before deploying. */
  d1Databases: z.array(
    z.strictObject({
      binding: bindingNameSchema,
      databaseName: workerNameSchema,
      migrations: z.array(fileRef),
    })
  ),
  /** The whole ordered Durable Object migration history. */
  durableObjectMigrations: z.array(z.looseObject({ tag: z.string() })),
  crons: z.array(z.string()),
  /** Secrets that must be set before this Worker can be deployed. */
  requiredSecrets: z.array(bindingNameSchema),
  /** Keep the vars the console set on the previous version. */
  keepVars: z.boolean(),
  workersDev: z.boolean(),
  previewUrls: z.boolean(),
  observability: observabilitySchema,
  /** Static assets: the API's `assets.config` and upload manifest. */
  assets: z
    .strictObject({
      config: z.strictObject({
        not_found_handling: z.string().optional(),
        run_worker_first: z
          .union([z.boolean(), z.array(z.string())])
          .optional(),
      }),
      manifest: z.record(z.string(), z.strictObject({ hash: assetHash, size })),
    })
    .optional(),
});

/** Everything the manifest says about one Worker. */
export type WorkerEntry = z.infer<typeof workerEntrySchema>;

/** The release manifest (see the header comment). */
export const releaseManifestSchema = z.strictObject({
  manifestVersion: z.literal(MANIFEST_VERSION),
  releaseId: releaseIdSchema,
  /** The full commit SHA it was built from. */
  commit: commitSchema,
  createdAt: z.iso.datetime(),
  /**
   * The release note: the squash commit's subject, which is the merged pull
   * request's Conventional Commit title.
   */
  notes: z.string(),
  wranglerVersion: z.string(),
  /** One compatibility date for the whole platform. */
  compatibilityDate: z.iso.date(),
  /** Installed versions of the Workers' and frontend's dependencies. */
  packages: z.record(z.string(), z.string()),
  /** By app: `core`, `connect`. */
  workers: z.record(z.string(), workerEntrySchema),
  /** Every asset blob, by content key. */
  assets: z.record(assetHash, z.strictObject({ size, r2Key: z.string() })),
  /** The platform limits core and connect were built with. */
  platformLimits: platformLimitsSchema,
  /** The release before it, which its limits are raised over. */
  previousRelease: previousReleaseSchema,
  /** The evidence for each limit it raises, per profile. */
  limitEvidence: z.array(limitEvidenceSchema),
});

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

/** Where a Worker module is stored, in the release directory and in R2. */
export const moduleKey = (hash: string): string => `blobs/modules/${hash}`;
/** Where a D1 migration is stored. */
export const migrationKey = (hash: string): string =>
  `blobs/migrations/${hash}`;
/** Where a static asset is stored. */
export const assetKey = (hash: string): string => `blobs/assets/${hash}`;
/** Where a release's manifest is stored; written last. */
export const manifestKey = (releaseId: string): string =>
  `releases/${releaseId}/manifest.json`;

/** Bytes whose buffer is a plain `ArrayBuffer`, as Web Crypto takes them. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** SHA-256 of `bytes`, lowercase hex. */
export const sha256OfBytes = async (bytes: Bytes): Promise<string> =>
  toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));

/** Bytes encoded at a time: a multiple of 3, so no chunk but the last pads. */
const BASE64_CHUNK = 0x60_00;

/**
 * Base64 of `bytes` followed by `suffix`, written straight into one buffer
 * a chunk at a time: an asset of n bytes costs about n * 4/3 more while
 * it's hashed, not whole-file strings.
 */
const base64Then = (bytes: Uint8Array, suffix: string): Bytes => {
  const encoder = new TextEncoder();
  const tail = encoder.encode(suffix);
  const length = Math.ceil(bytes.length / 3) * 4;
  const out = new Uint8Array(length + tail.length);
  let at = 0;
  for (let start = 0; start < bytes.length; start += BASE64_CHUNK) {
    const chunk = btoa(
      String.fromCodePoint(...bytes.subarray(start, start + BASE64_CHUNK))
    );
    at += encoder.encodeInto(chunk, out.subarray(at)).written;
  }
  out.set(tail, length);
  return out;
};

/**
 * A path's extension without its dot, as Wrangler finds it for the same
 * key (Node's `path.extname`): none for a dot-file such as `.hidden`, and
 * only the last one for `a.tar.gz`.
 */
const extensionOf = (filePath: string): string => {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1);
};

/** An asset, encoded once for its content key and its upload. */
export interface EncodedAsset {
  /** The static-asset content key (see the header comment). */
  key: string;
  /** Its contents as base64 (ASCII bytes): the assets-upload API's body. */
  base64: Bytes;
}

/** Encodes an asset at `filePath`: its content key and its base64. */
export const encodeAsset = async (
  bytes: Uint8Array,
  filePath: string
): Promise<EncodedAsset> => {
  const extension = extensionOf(filePath);
  const input = base64Then(bytes, extension);
  const hash = await crypto.subtle.digest("SHA-256", input);
  return {
    key: toHex(new Uint8Array(hash)).slice(0, 32),
    base64: input.subarray(0, Math.ceil(bytes.length / 3) * 4),
  };
};

/** The static-asset content key (see the header comment). */
export const assetContentKey = async (
  bytes: Uint8Array,
  filePath: string
): Promise<string> => {
  const { key } = await encodeAsset(bytes, filePath);
  return key;
};

/**
 * Reads the blob at an R2 key, whose manifest says it's `size` bytes;
 * undefined when there's none. A reader may refuse a blob of another size
 * before reading it.
 */
export type ReadBlob = (
  key: string,
  size: number
) => Promise<Bytes | undefined>;

/** What a blob's bytes must be, for one place the manifest names it. */
type Expectation =
  | { kind: "file"; name: string; sha256: string; size: number }
  | { kind: "asset"; size: number }
  | { kind: "served"; path: string; hash: string; size: number };

/** Blobs read at once while verifying, unless the caller says otherwise. */
const VERIFY_CONCURRENCY = 8;

/**
 * Runs `task` on each of `items`, at most `limit` at a time, and returns
 * the results in the order of `items`. The first failure stops it taking
 * more (the tasks already running finish) and is what it throws.
 */
export const mapConcurrently = async <T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = [];
  // One iterator shared by every worker: each takes the next item.
  const entries = items.entries();
  let failed = false;
  const work = async (): Promise<void> => {
    for (const [index, item] of entries) {
      if (failed) {
        return;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- each worker runs one task at a time
        results[index] = await task(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, work)
  );
  return results;
};

/** Every blob the manifest names, with what its bytes must be. */
const expectationsOf = (
  manifest: ReleaseManifest
): Map<string, Expectation[]> => {
  const expected = new Map<string, Expectation[]>();
  const expect = (key: string, expectation: Expectation): void => {
    expected.set(key, [...(expected.get(key) ?? []), expectation]);
  };

  // Only the content-addressed form, which is plain hex under blobs/: an
  // r2Key can never name anything outside the release's blobs.
  for (const [hash, blob] of Object.entries(manifest.assets)) {
    if (blob.r2Key !== assetKey(hash)) {
      throw new Error(`${blob.r2Key} isn't stored at its content address`);
    }
    expect(blob.r2Key, { kind: "asset", size: blob.size });
  }

  const served = new Set<string>();
  for (const worker of Object.values(manifest.workers)) {
    const files = [
      ...worker.modules.map((file) => ({ file, key: moduleKey })),
      ...worker.d1Databases.flatMap((database) =>
        database.migrations.map((file) => ({ file, key: migrationKey }))
      ),
    ];
    for (const { file, key } of files) {
      if (file.r2Key !== key(file.sha256)) {
        throw new Error(`${file.r2Key} isn't stored at its content address`);
      }
      expect(file.r2Key, {
        kind: "file",
        name: file.name,
        sha256: file.sha256,
        size: file.size,
      });
    }
    for (const [assetPath, entry] of Object.entries(
      worker.assets?.manifest ?? {}
    )) {
      if (!Object.hasOwn(manifest.assets, entry.hash)) {
        throw new Error(`${assetPath} isn't in the release's asset index`);
      }
      expect(assetKey(entry.hash), {
        kind: "served",
        path: assetPath,
        hash: entry.hash,
        size: entry.size,
      });
      served.add(entry.hash);
    }
  }

  const unserved = Object.keys(manifest.assets).filter(
    (hash) => !served.has(hash)
  );
  if (unserved.length > 0) {
    throw new Error(
      `The asset index lists blobs no Worker serves: ${unserved.join(", ")}`
    );
  }
  return expected;
};

/** Throws unless `bytes` is what `expectation` says the blob at `key` is. */
const check = async (
  key: string,
  bytes: Bytes,
  expectation: Expectation
): Promise<void> => {
  switch (expectation.kind) {
    case "file": {
      if (
        bytes.length !== expectation.size ||
        (await sha256OfBytes(bytes)) !== expectation.sha256
      ) {
        throw new Error(`${key} (${expectation.name}) doesn't match its hash`);
      }
      return;
    }
    case "asset": {
      if (bytes.length !== expectation.size) {
        throw new Error(`${key} doesn't match its hash`);
      }
      return;
    }
    case "served": {
      if (
        bytes.length !== expectation.size ||
        (await assetContentKey(bytes, expectation.path)) !== expectation.hash
      ) {
        throw new Error(`${expectation.path} doesn't match its hash`);
      }
      return;
    }
    default: {
      throw new Error("Unknown expectation");
    }
  }
};

/**
 * Checks a release's blobs against its manifest: every module, migration
 * and asset is stored at its content address, is present, and its bytes
 * hash to it; every entry in the asset index is one a Worker serves. Each
 * blob is read once, through `read`, at most `concurrency` at a time, and
 * checked for every place the manifest names it; a reader that keeps what
 * it returns holds exactly the bytes that were checked. Throws on the
 * first mismatch.
 */
export const verifyReleaseBlobs = async (
  manifest: ReleaseManifest,
  read: ReadBlob,
  { concurrency = VERIFY_CONCURRENCY }: { concurrency?: number } = {}
): Promise<void> => {
  const verifyOne = async ([key, expectations]: [
    string,
    Expectation[],
  ]): Promise<void> => {
    // Every place names the blob's size; they differ only in a broken
    // manifest, which the checks below then refuse.
    const bytes = await read(key, expectations[0]?.size ?? 0);
    if (bytes === undefined) {
      throw new Error(`${key} is missing from the release`);
    }
    for (const expectation of expectations) {
      // oxlint-disable-next-line no-await-in-loop -- a blob's checks run in turn
      await check(key, bytes, expectation);
    }
  };
  await mapConcurrently([...expectationsOf(manifest)], concurrency, verifyOne);
};

/** How many blobs a release names: what verifying it reads, besides its manifest. */
export const blobCount = (manifest: ReleaseManifest): number =>
  expectationsOf(manifest).size;
