/**
 * The release manifest: the contract between CI, which builds core and
 * connect once per commit (scripts/release), and the admin, which imports
 * each release and deploys those exact bytes into client accounts.
 *
 * Blobs are content-addressed, in two schemes on purpose:
 * - Worker modules, D1 migrations and model files by their full SHA-256
 *   (hex): our own scheme, for deduplication in R2 and for checking that
 *   what the admin deploys is what CI built.
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
 * Model files (the embedder's weights, @grasp-os/embed) are named by the
 * release but not carried in each build: at about 100 MB they aren't in
 * git, and each is put in the releases bucket once, under its hash
 * (scripts/release/upload-model-files.ts). A release names them by hash and
 * size; publishing it checks the bucket holds them, the admin's import
 * checks them by R2's own SHA-256, and a deploy copies each into the
 * client's models bucket, at `deployedModelKey`, where core's embedder
 * reads and checks it again.
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

const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);

/** Where a model file is stored in the releases bucket. */
export const modelBlobKey = (hash: string): string => `blobs/models/${hash}`;

/**
 * Where a deployment keeps a model file: in the bucket core binds as
 * `modelFilesBinding`, where the embedder reads it by its hash.
 */
export const deployedModelKey = (hash: string): string =>
  `embed-models/${hash}`;

/** What every key `deployedModelKey` makes starts with. */
export const deployedModelPrefix = deployedModelKey("");

/** Exactly the keys `deployedModelKey` makes: its prefix and a SHA-256. */
export const deployedModelKeyPattern = /^embed-models\/[0-9a-f]{64}$/u;

/** The binding core reads model files through, and the deploy copies them into. */
export const modelFilesBinding = "MODEL_FILES";

/** A model file the release names, stored at its content address. */
const modelFileSchema = fileRef.refine(
  (file) => file.r2Key === modelBlobKey(file.sha256),
  "A model file is stored at its content address"
);

/** A model file a release names. */
export type ModelFileRef = z.infer<typeof modelFileSchema>;

/** What a bucket reports of a stored model file: its size, and the SHA-256 (hex) it kept, if any. */
export interface StoredModelFile {
  size: number;
  sha256?: string;
}

/**
 * Why `stored` isn't `file` as a release may name it, or undefined when it
 * is: there, at its size, with the SHA-256 R2 computed and kept when it
 * was stored. The one rule CI's publish and the admin's import hold a
 * model file to, so a release that publishes always imports. One kept
 * without its SHA-256 fails, whatever its bytes: the import never reads
 * 100 MB to find out.
 */
export const storedModelFileProblem = (
  file: Pick<ModelFileRef, "sha256" | "size">,
  stored: StoredModelFile | null
): string | undefined => {
  if (stored === null) {
    return "is missing";
  }
  if (stored.size !== file.size) {
    return `is ${stored.size} bytes, not ${file.size}`;
  }
  if (stored.sha256 === undefined) {
    return "was stored without its SHA-256";
  }
  return stored.sha256 === file.sha256 ? undefined : "doesn't match its hash";
};

const workerEntrySchema = z.strictObject({
  /** The Worker's name in every client account. */
  name: workerNameSchema,
  /** The entry module, one of `modules`. */
  mainModule: z.string(),
  modules: z.array(
    fileRef.extend({
      type: z.enum(["esm", "text", "wasm", "data", "sourcemap"]),
    })
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

/** The release manifest (see the header comment); unknown top-level fields are ignored. */
export const releaseManifestSchema = z.object({
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
   * The model files core's embedder runs, in the releases bucket but not
   * in the build (see the header comment). A release from before they were
   * named names none.
   */
  modelFiles: z.array(modelFileSchema).default([]),
});

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

/**
 * The package that stores core's chats: pi-durable keeps a chat's records
 * in its Durable Object, each record at a version of its own, and a later
 * minor may write versions an earlier one refuses to read (Pi 1.6 did:
 * `pi.live` 3, `pi.tool` 4 and `pi.generation` 3, none of which Pi 1.4
 * opens). Chord and pi-schema are pinned with it, and move with it.
 */
const chatStorePackage = "@earendil-works/pi-durable";

/** A release's major and minor of pi-durable, as `packages` records it; null when it names none. */
const chatStorageOf = (
  manifest: ReleaseManifest
): readonly [number, number] | null => {
  const [major, minor] = (manifest.packages[chatStorePackage] ?? "")
    .split(".")
    .map(Number);
  return major === undefined ||
    minor === undefined ||
    !Number.isInteger(major) ||
    !Number.isInteger(minor)
    ? null
    : [major, minor];
};

/**
 * Whether a client on release `to` still opens every chat its core stored
 * on release `from`: `to` runs at least `from`'s major and minor of
 * pi-durable. A patch never changes how chats are stored, and every minor
 * may, so each new minor is a boundary a client never goes back across.
 * Read from what every manifest has recorded since the first, the
 * installed versions of its packages, so it holds for releases imported
 * before this rule too. A release that names no pi-durable counts as
 * storing no chats, and one that names it never goes to one without it.
 */
export const readsChatsOf = (
  to: ReleaseManifest,
  from: ReleaseManifest
): boolean => {
  const stored = chatStorageOf(from);
  if (stored === null) {
    return true;
  }
  const reads = chatStorageOf(to);
  if (reads === null) {
    return false;
  }
  return reads[0] === stored[0] ? reads[1] >= stored[1] : reads[0] > stored[0];
};

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

/** Blobs read at once while verifying. */
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

/** A blob a release names, and what its bytes must be at each place it's named. */
export interface ReleaseBlob {
  /** Its R2 key: its content address. */
  key: string;
  expectations: Expectation[];
}

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
 * Every blob a release names but its model files (which aren't in a build
 * and are each checked where they're stored, without reading 100 MB
 * whole), in the order its manifest names them, the same for the same
 * manifest, each with what its bytes must be wherever it's named. Throws
 * unless every module, migration and asset is named by its content
 * address and every entry in the asset index is one a Worker serves.
 */
export const blobsOf = (manifest: ReleaseManifest): ReleaseBlob[] =>
  [...expectationsOf(manifest)].map(([key, expectations]) => ({
    key,
    expectations,
  }));

/**
 * The size the manifest gives `blob`. Every place it's named gives one;
 * they differ only in a broken manifest, which `checkBlob` and
 * `storedBlobProblem` refuse.
 */
export const blobSize = (blob: ReleaseBlob): number =>
  blob.expectations[0]?.size ?? 0;

/**
 * Throws unless `bytes`, read from `blob`'s key (undefined: nothing is
 * stored there), hash to what every place the manifest names it says.
 */
export const checkBlob = async (
  blob: ReleaseBlob,
  bytes: Bytes | undefined
): Promise<void> => {
  if (bytes === undefined) {
    throw new Error(`${blob.key} is missing from the release`);
  }
  for (const expectation of blob.expectations) {
    // oxlint-disable-next-line no-await-in-loop -- a blob's checks run in turn
    await check(blob.key, bytes, expectation);
  }
};

/**
 * Why what a bucket reports of the object at `blob`'s key (null: there's
 * none) isn't `blob`, or undefined when nothing it reports says so: it's
 * there, at the size every place names, and a blob named by its SHA-256
 * (a module or migration) has that SHA-256 if R2 kept one. CI stores
 * every blob with its SHA-256, which R2 checks as it takes the bytes
 * (scripts/release/upload-release.ts). What this can't see, only reading
 * the bytes does: an asset's (named by Cloudflare's content key, which R2
 * doesn't compute, and which takes each path's extension), or a file's R2
 * kept no SHA-256 for, of the same size.
 */
export const storedBlobProblem = (
  blob: ReleaseBlob,
  stored: { size: number; sha256?: string } | null
): string | undefined => {
  if (stored === null) {
    return "is missing from the release";
  }
  if (blob.expectations.some(({ size: named }) => named !== stored.size)) {
    return `is ${stored.size} bytes, not ${blobSize(blob)}`;
  }
  const named = blob.expectations.flatMap((expectation) =>
    expectation.kind === "file" ? [expectation.sha256] : []
  );
  return stored.sha256 !== undefined &&
    named.some((hash) => hash !== stored.sha256)
    ? "doesn't match its hash"
    : undefined;
};

/**
 * Checks a release's blobs against its manifest (`blobsOf`): each one is
 * read once, through `read`, a few at a time, and checked for every place
 * the manifest names it (`checkBlob`); a reader that keeps what it
 * returns holds exactly the bytes that were checked. Throws on the first
 * mismatch.
 */
export const verifyReleaseBlobs = async (
  manifest: ReleaseManifest,
  read: ReadBlob
): Promise<void> => {
  await mapConcurrently(blobsOf(manifest), VERIFY_CONCURRENCY, async (blob) => {
    await checkBlob(blob, await read(blob.key, blobSize(blob)));
  });
};

/**
 * Every blob key the manifest names, its model files' included. Blobs are
 * content-addressed, so releases share them: one may leave the bucket
 * only once no kept release names it.
 */
export const blobKeys = (manifest: ReleaseManifest): string[] => [
  ...expectationsOf(manifest).keys(),
  ...manifest.modelFiles.map((file) => file.r2Key),
];
