/**
 * The release manifest: the contract between CI, which builds core and
 * connect once per commit (scripts/release), and the admin, which imports
 * each release and deploys those exact bytes into client accounts.
 *
 * Blobs are content-addressed, in two schemes on purpose:
 * - Worker modules and D1 migrations by their full SHA-256 (hex): our own
 *   scheme, for deduplication in R2 and for checking that what the admin
 *   deploys is what CI built.
 * - Static assets by the content key of Cloudflare's assets-upload API:
 *   SHA-256 of base64(contents) plus the file's extension, hex, cut to 32
 *   characters. The API treats it as an opaque key per file (Wrangler
 *   computes the same shape with BLAKE3), so CI and the admin only have to
 *   agree with each other, byte for byte.
 *
 * Account-specific values in a Worker's bindings are placeholders the
 * admin fills in for the Worker it deploys:
 *
 *   $D1_<BINDING>_ID   the id of the D1 database that binding names
 *
 * The placeholder list is closed: the admin refuses a `$` token it doesn't
 * know, so the generator and the admin change together, behind
 * MANIFEST_VERSION.
 *
 * Nothing but Web APIs, so CI (Node) and the admin (workerd) verify a
 * release with the same code.
 */
import { z } from "zod";

import { toHex } from "./encoding.ts";
import { releaseIdSchema } from "./release-id.ts";

/** The manifest shape the admin must understand (see the header comment). */
export const MANIFEST_VERSION = 1;

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

// Platform limits and the evidence for raising one.
//
// A platform limit (platform-limits.ts) is raised only by a release, and
// only with evidence CI produced for it: a capacity run on the release's
// own commit, for a runtime profile, and the security review of the change
// (its pull request and the CODEOWNERS approval). Never a success report
// from a client's core. Three places hold a release to it, with these
// rules:
// - CI's publish, which fails before uploading a release whose raises it
//   has no evidence for (scripts/release/evidence-release.ts). The release
//   is built once, before it is published (and before staging runs it), so
//   its manifest records only the limits its code was built with; what
//   they are raised over, and the evidence, are known only at publish, and
//   go next to the manifest in their own file (`limitEvidenceFileSchema`).
// - The admin's import (`verifyLimitEvidence`): the evidence is exactly
//   the release's own raises over the release before it, each entry
//   naming the manifest's commit and release id.
// - Every deploy of a release to a client (`uncoveredRaise`): a limit
//   higher than what the client runs needs evidence for the client's
//   profile, from the admin's own records rather than the file's word
//   about its predecessor.
// None of this stops someone who can write the releases bucket: they can
// write a consistent manifest and file with forged evidence, as they can
// forge the release. Binding them to their producer (a signature checked
// on import, GRA-891's pattern) closes that, and these checks run
// unchanged after it.

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
  /**
   * The security review of the change: every pull request merged since
   * the release before it that touched the platform limits or a capacity
   * workload, each with its CODEOWNER's approval, oldest first. At least
   * one: the change that raised it.
   */
  securityReviews: z
    .array(
      z.strictObject({
        pullRequest: z.int().positive(),
        approvedBy: githubLoginSchema,
      })
    )
    .min(1),
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

/**
 * What a release says about its limits: the limits its manifest records,
 * and what its evidence file says they're raised over, with the evidence.
 */
export interface ReleaseLimits {
  releaseId: string;
  commit: string;
  platformLimits: PlatformLimits;
  previousRelease: PreviousRelease;
  limitEvidence: readonly LimitEvidence[];
}

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
  /** Keep the vars the admin set on the previous version. */
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

/** Versions from `min` to `max`, both included. */
const versionRangeSchema = z
  .strictObject({ min: z.int().positive(), max: z.int().positive() })
  .refine(({ min, max }) => min <= max, "A range's min is at most its max");

/**
 * A D1 database's schema, by migration number: the `0016` of
 * `0016_pending_action_keys.sql`. Migrations are numbered in the order
 * they're applied, so a schema is its newest migration's number.
 */
const migrationNumberSchema = z.int().nonnegative();

/** What a release's code needs of one D1 database, and what its schema keeps. */
const databaseSchemaSchema = z
  .strictObject({
    /**
     * The schema its code needs: its newest migration, which a deploy
     * applies before any of its code runs.
     */
    schema: migrationNumberSchema,
    /**
     * The oldest schema whose code still runs on this one: code of a
     * release whose newest migration is older doesn't. A migration that
     * only expands leaves it where it is; one that contracts (drops or
     * renames what an older release's code uses) raises it.
     */
    compatibleFrom: migrationNumberSchema,
  })
  .refine(
    ({ schema, compatibleFrom }) => compatibleFrom <= schema,
    "A schema is compatible from no later than itself"
  );

/**
 * The interface a Worker serves the release's other Workers: the newest
 * version, `serves`, and the oldest it still serves correctly,
 * `servesFrom`. A change that only adds to an interface is a new version
 * that still serves the callers of the versions before it, so a caller of
 * the release before keeps working while the Workers switch one at a time;
 * one that drops or changes what an older caller uses raises `servesFrom`
 * past that caller's version. Releases built before `servesFrom` was
 * declared have none, and serve exactly `serves`.
 */
const servedInterfaceSchema = z
  .strictObject({
    serves: z.int().positive().optional(),
    servesFrom: z.int().positive().optional(),
    calls: z.record(z.string(), versionRangeSchema),
  })
  .refine(
    ({ serves, servesFrom }) =>
      servesFrom === undefined ||
      (serves !== undefined && servesFrom <= serves),
    "An interface is served from no later than its newest version, and only when one is served"
  );

/**
 * What a release's code works with, which the admin checks before it
 * makes the release live in a client (spec 40.3): every Worker that
 * calls another must call a version that one serves, at each step of a
 * deploy or rollback, since a client's Workers switch one at a time; and
 * the release must read every workflow journal and run every App
 * release the client's current code may have left, and run on every D1
 * database's schema the client's migrations left: a deploy applies the
 * release's migrations first, but a rollback applies none, and a
 * release's code may run on the schema of a later one only as far as
 * that one's migrations kept it working.
 */
export const releaseCompatibilitySchema = z.strictObject({
  /**
   * By app: the versions of the interface it serves the release's other
   * Workers, if it serves one (`servedInterfaceSchema`), and the versions
   * of each other Worker's interface it calls correctly.
   */
  interfaces: z.record(z.string(), servedInterfaceSchema),
  /** The workflow journal schemas core's engine reads. */
  workflowJournal: versionRangeSchema,
  /** The SDK protocol versions of the App releases core runs. */
  sdkProtocols: versionRangeSchema,
  /**
   * By name, each D1 database it ships migrations for. Releases built
   * before it was declared have none, and the admin checks their
   * schemas only by the old rule: migrations only expand for the release
   * before, and a rollback goes back no further than that release.
   */
  databases: z.record(workerNameSchema, databaseSchemaSchema).optional(),
});

export type ReleaseCompatibility = z.infer<typeof releaseCompatibilitySchema>;

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
  /**
   * What its code works with. Releases built before it was declared
   * have none, and the admin makes none of those live.
   */
  compatibility: releaseCompatibilitySchema.optional(),
  /**
   * The platform limits core and connect were built with. Releases built
   * before they were recorded have none, and the admin makes none of
   * those live (src/releases/limits.ts).
   */
  platformLimits: platformLimitsSchema.optional(),
});

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

/**
 * A release's limit evidence, as CI's publish writes it next to the
 * manifest (scripts/release/evidence-release.ts): the release it's for,
 * the release published before it, which its limits are raised over, and
 * an entry per raised limit and profile. Every release that records
 * limits has one, with no entries when it raises nothing.
 */
export const limitEvidenceFileSchema = z.strictObject({
  releaseId: releaseIdSchema,
  commit: commitSchema,
  previousRelease: previousReleaseSchema,
  limitEvidence: z.array(limitEvidenceSchema),
});
export type LimitEvidenceFile = z.infer<typeof limitEvidenceFileSchema>;

/** Where a Worker module is stored, in the release directory and in R2. */
export const moduleKey = (hash: string): string => `blobs/modules/${hash}`;
/** Where a D1 migration is stored. */
export const migrationKey = (hash: string): string =>
  `blobs/migrations/${hash}`;
/** Where a static asset is stored. */
export const assetKey = (hash: string): string => `blobs/assets/${hash}`;
/**
 * Where a release's limit evidence is stored (`limitEvidenceFileSchema`):
 * written at publish, just before its manifest.
 */
export const limitEvidenceKey = (releaseId: string): string =>
  `releases/${releaseId}/limit-evidence.json`;
/** Its file's name in a release directory. */
export const limitEvidenceFile = "limit-evidence.json";
/** Where a release's manifest is stored; written last. */
export const manifestKey = (releaseId: string): string =>
  `releases/${releaseId}/manifest.json`;
/**
 * Where CI's publish records the release a commit was published as (its
 * id, as text), written once that release's manifest is: a re-run of the
 * commit's publish finds it there and publishes nothing again.
 */
export const commitKey = (commit: string): string => `commits/${commit}`;

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
 *
 * `from` and `to` check only the blobs at those places, in the order the
 * manifest names them (the same for the same manifest), so a reader with a
 * bound on its reads can check a release a batch at a time.
 */
export const verifyReleaseBlobs = async (
  manifest: ReleaseManifest,
  read: ReadBlob,
  {
    concurrency = VERIFY_CONCURRENCY,
    from = 0,
    to,
  }: { concurrency?: number; from?: number; to?: number } = {}
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
  await mapConcurrently(
    [...expectationsOf(manifest)].slice(from, to),
    concurrency,
    verifyOne
  );
};

/** How many blobs a release names: what verifying it reads, besides its manifest. */
export const blobCount = (manifest: ReleaseManifest): number =>
  expectationsOf(manifest).size;
