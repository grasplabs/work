/**
 * Publishes releases to the test pool's R2 bucket laid out as CI publishes
 * them (scripts/release/upload-release.ts): content-addressed blobs first,
 * then the limit evidence (with the SHA-256 R2 checks on write), then
 * `releases/<id>/manifest.json`.
 */
import {
  assetContentKey,
  assetKey,
  limitEvidenceKey,
  MANIFEST_VERSION,
  manifestKey,
  migrationKey,
  moduleKey,
  releaseManifestSchema,
  sha256OfBytes,
} from "@grasp-os/shared/release";
import type {
  LimitEvidence,
  LimitEvidenceFile,
  PlatformLimits,
  PreviousRelease,
  ReleaseCompatibility,
  ReleaseManifest,
  RuntimeProfile,
  WorkerEntry,
} from "@grasp-os/shared/release";
import { env } from "cloudflare:workers";

const encoder = new TextEncoder();

/** What a test release holds; everything else is fixed. */
export interface ReleaseSpec {
  notes: string;
  /** core's entry module. */
  core?: string;
  /** connect's entry module. */
  connect?: string;
  /** core's D1 migrations, by file name, in order. */
  migrations?: Record<string, string>;
  /** core's static assets, by URL path. */
  assets?: Record<string, string>;
  packages?: Record<string, string>;
  crons?: string[];
  /** Secrets core requires besides its derived ones. */
  coreSecrets?: string[];
  /** core's Durable Object migration tags, in order: `v1` by default. */
  durableObjectMigrations?: string[];
  /**
   * Whether core sends mail, binding `EMAIL` (`send_email`) as the real
   * one does; without it, a deploy sets up no sending domain.
   */
  sendsMail?: boolean;
  /** What its code works with: `declared` by default, none when null. */
  compatibility?: ReleaseCompatibility | null;
  /**
   * By name, a database's oldest migration whose code runs on its schema
   * (0 for one it doesn't name). With it, the release declares each
   * database's schema from its migrations, as the release build does;
   * without it, none, as releases built before that did.
   */
  compatibleFrom?: Record<string, number>;
  /** Its platform limits: {@link testLimits} by default, none when null. */
  platformLimits?: PlatformLimits | null;
  /** The release before it, as its evidence file names it: none by default. */
  previousRelease?: PreviousRelease;
  /** Its limit evidence, made for the release once its id and commit are known. */
  limitEvidence?: (release: { id: string; commit: string }) => LimitEvidence[];
}

/** The platform limits a test release has unless its spec says otherwise. */
export const testLimits: PlatformLimits = {
  workflowSteps: 1000,
  workflowBranches: 8,
};

/**
 * Evidence for raising `limit` to `raisedTo` on `profile`, as CI makes it
 * for `release`: its own commit and id, a capacity run on that commit.
 */
export const evidenceFor = (
  release: { id: string; commit: string },
  limit: string,
  raisedTo: number | null,
  profile: RuntimeProfile = "cloudflare"
): LimitEvidence => ({
  limit,
  raisedTo,
  commit: release.commit,
  releaseId: release.id,
  profile,
  capacityRun: { jobId: 4242, commit: release.commit, profile },
  securityReview: { pullRequest: 101, approvedBy: "nickruigrok" },
});

/** What a test release's code works with unless its spec says otherwise. */
export const declared: ReleaseCompatibility = {
  interfaces: {
    connect: { serves: 1, calls: {} },
    core: { calls: { connect: { min: 1, max: 1 } } },
  },
  workflowJournal: { min: 8, max: 9 },
  sdkProtocols: { min: 2, max: 2 },
};

/** A built release: its manifest and every blob, by R2 key. */
export interface TestRelease {
  id: string;
  manifest: ReleaseManifest;
  /** The manifest as it's stored. */
  manifestText: string;
  blobs: Map<string, Uint8Array>;
  /** Its limit evidence file as it's stored; none without limits. */
  limitEvidenceText: string | undefined;
}

// A fresh range per test file, rising within it, so each new release is the
// newest in the bucket. Nine digits keep the ids sorting by run.
const firstRun = 100_000_000 + Math.floor(Math.random() * 800_000_000);
let runs = 0;
// Build times a minute apart, in the order of the releases' ids: never
// the same millisecond, however fast the test runs.
const firstBuild = Date.now();

const randomHex = (length: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) =>
    (byte % 16).toString(16)
  ).join("");

/** A new release id, newer than every one before it in this file. */
export const nextReleaseId = (): string => {
  runs += 1;
  return `r${firstRun + runs}-${randomHex(7)}`;
};

const file = async (
  name: string,
  content: string,
  key: (hash: string) => string,
  blobs: Map<string, Uint8Array>
) => {
  const bytes = encoder.encode(content);
  const sha256 = await sha256OfBytes(bytes);
  blobs.set(key(sha256), bytes);
  return { name, sha256, size: bytes.length, r2Key: key(sha256) };
};

const worker = (
  name: string,
  crons: string[]
): Omit<WorkerEntry, "modules"> => ({
  name,
  mainModule: "index.js",
  compatibilityFlags: ["nodejs_compat"],
  bindings: [],
  d1Databases: [],
  durableObjectMigrations: [],
  crons,
  requiredSecrets: [],
  keepVars: true,
  workersDev: false,
  previewUrls: false,
  observability: { enabled: true },
});

/**
 * The databases' schemas a release of `spec` declares, core's at
 * `coreSchema` and the others at their one migration; none without
 * `spec.compatibleFrom`.
 */
const databasesOf = (
  { compatibleFrom }: ReleaseSpec,
  coreSchema: number
): Pick<ReleaseCompatibility, "databases"> => {
  if (compatibleFrom === undefined) {
    return {};
  }
  const schemas = {
    "grasp-os-connect": 0,
    "grasp-os-core": coreSchema,
    "grasp-os-knowledge": 0,
  };
  return {
    databases: Object.fromEntries(
      Object.entries(schemas).map(([name, schema]) => [
        name,
        { schema, compatibleFrom: compatibleFrom[name] ?? 0 },
      ])
    ),
  };
};

/** The limits a release of `spec` records, and its evidence file. */
const limitsOf = (
  spec: ReleaseSpec,
  id: string,
  commit: string
): {
  manifest: { platformLimits?: PlatformLimits };
  evidence: LimitEvidenceFile | undefined;
} => {
  if (spec.platformLimits === null) {
    return { manifest: {}, evidence: undefined };
  }
  return {
    manifest: { platformLimits: spec.platformLimits ?? testLimits },
    evidence: {
      releaseId: id,
      commit,
      previousRelease: spec.previousRelease ?? null,
      limitEvidence: spec.limitEvidence?.({ id, commit }) ?? [],
    },
  };
};

/** Builds release `id` from `spec`, without publishing it. */
export const buildRelease = async (
  spec: ReleaseSpec,
  id = nextReleaseId()
): Promise<TestRelease> => {
  const blobs = new Map<string, Uint8Array>();
  const module = async (content: string) => ({
    ...(await file("index.js", content, moduleKey, blobs)),
    type: "esm" as const,
  });
  const migrations = await Promise.all(
    Object.entries(
      spec.migrations ?? { "0000_init.sql": "CREATE TABLE a (id TEXT);" }
    ).map(
      async ([name, content]) => await file(name, content, migrationKey, blobs)
    )
  );
  // The databases core and connect also bind, as in the real release.
  const [knowledge, connectDb] = await Promise.all([
    file(
      "0000_knowledge.sql",
      "CREATE TABLE k (id TEXT);",
      migrationKey,
      blobs
    ),
    file("0000_connect.sql", "CREATE TABLE c (id TEXT);", migrationKey, blobs),
  ]);
  const assetManifest: Record<string, { hash: string; size: number }> = {};
  const assets: ReleaseManifest["assets"] = {};
  for (const [path, content] of Object.entries(
    spec.assets ?? { "/index.html": "<html></html>" }
  )) {
    const bytes = encoder.encode(content);
    // oxlint-disable-next-line no-await-in-loop -- a handful of assets
    const hash = await assetContentKey(bytes, path);
    assetManifest[path] = { hash, size: bytes.length };
    assets[hash] = { size: bytes.length, r2Key: assetKey(hash) };
    blobs.set(assetKey(hash), bytes);
  }
  const commit = `${id.slice(-7)}${randomHex(33)}`;
  const limits = limitsOf(spec, id, commit);
  const manifest = releaseManifestSchema.parse({
    manifestVersion: MANIFEST_VERSION,
    releaseId: id,
    commit,
    // From the id's run, so releases built at once still get their order.
    createdAt: new Date(
      firstBuild + (Number(id.slice(1, id.indexOf("-"))) - firstRun) * 60_000
    ).toISOString(),
    notes: spec.notes,
    wranglerVersion: "4.0.0",
    compatibilityDate: "2026-09-15",
    packages: spec.packages ?? { zod: "4.0.0" },
    workers: {
      connect: {
        ...worker("grasp-os-connect", []),
        requiredSecrets: ["CAPABILITY_SIGNING_KEY"],
        modules: [await module(spec.connect ?? "export default {};")],
        bindings: [{ type: "d1", name: "DB", id: "$D1_DB_ID" }],
        d1Databases: [
          {
            binding: "DB",
            databaseName: "grasp-os-connect",
            migrations: [connectDb],
          },
        ],
      },
      core: {
        ...worker("grasp-os-core", spec.crons ?? ["* * * * *"]),
        workersDev: true,
        requiredSecrets: [
          "ROUTER_SECRET",
          "BETTER_AUTH_SECRET",
          "CAPABILITY_SIGNING_KEY",
          ...(spec.coreSecrets ?? []),
        ],
        durableObjectMigrations: (spec.durableObjectMigrations ?? ["v1"]).map(
          (tag) => ({ tag, new_sqlite_classes: [`Class${tag}`] })
        ),
        modules: [await module(spec.core ?? "export default { core: 1 };")],
        bindings: [
          {
            type: "durable_object_namespace",
            name: "WORKSPACES",
            class_name: "Workspace",
          },
          {
            type: "workflow",
            name: "WORKFLOWS",
            workflow_name: "grasp-os-workflows",
            class_name: "WorkflowDispatcher",
          },
          { type: "service", name: "CONNECT", service: "grasp-os-connect" },
          { type: "worker_loader", name: "LOADER" },
          { type: "version_metadata", name: "CF_VERSION_METADATA" },
          { type: "assets", name: "ASSETS" },
          { type: "d1", name: "DB", id: "$D1_DB_ID" },
          { type: "d1", name: "KNOWLEDGE", id: "$D1_KNOWLEDGE_ID" },
          {
            type: "r2_bucket",
            name: "FILES",
            bucket_name: "grasp-os-files",
            jurisdiction: "eu",
          },
          {
            type: "r2_bucket",
            name: "AUDIT_ARCHIVE",
            bucket_name: "grasp-os-audit-archive",
            jurisdiction: "eu",
          },
          ...(spec.sendsMail === true
            ? [{ type: "send_email", name: "EMAIL" }]
            : []),
        ],
        d1Databases: [
          { binding: "DB", databaseName: "grasp-os-core", migrations },
          {
            binding: "KNOWLEDGE",
            databaseName: "grasp-os-knowledge",
            migrations: [knowledge],
          },
        ],
        assets: { config: {}, manifest: assetManifest },
      },
    },
    assets,
    ...(spec.compatibility === null
      ? {}
      : {
          compatibility: {
            ...(spec.compatibility ?? declared),
            ...databasesOf(spec, migrations.length - 1),
          },
        }),
    ...limits.manifest,
  });
  return {
    id,
    manifest,
    manifestText: `${JSON.stringify(manifest, null, 2)}\n`,
    blobs,
    limitEvidenceText:
      limits.evidence === undefined
        ? undefined
        : `${JSON.stringify(limits.evidence)}\n`,
  };
};

/** Stores a release's blobs, as CI does before its manifest. */
export const putBlobs = async (
  release: Pick<TestRelease, "blobs">
): Promise<void> => {
  await Promise.all(
    [...release.blobs].map(
      async ([key, bytes]) => await env.RELEASES.put(key, bytes)
    )
  );
};

/**
 * Stores a release's limit evidence with its SHA-256, as CI does just
 * before the manifest, R2 checking it on write.
 */
export const putLimitEvidence = async (
  release: Pick<TestRelease, "id" | "limitEvidenceText">
): Promise<void> => {
  if (release.limitEvidenceText === undefined) {
    return;
  }
  const bytes = encoder.encode(release.limitEvidenceText);
  await env.RELEASES.put(limitEvidenceKey(release.id), bytes, {
    sha256: await sha256OfBytes(bytes),
  });
};

/** Stores a release's manifest, as CI does last, its evidence just before. */
export const putManifest = async (release: TestRelease): Promise<void> => {
  await putLimitEvidence(release);
  await env.RELEASES.put(manifestKey(release.id), release.manifestText);
};

/** Builds a release from `spec` and publishes it, blobs first. */
export const publishRelease = async (
  spec: ReleaseSpec
): Promise<TestRelease> => {
  const release = await buildRelease(spec);
  await putBlobs(release);
  await putManifest(release);
  return release;
};
