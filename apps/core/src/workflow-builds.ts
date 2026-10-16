import {
  appModuleName,
  compilerVersion,
  openWorkflowEntry,
  workflowSdkModules,
} from "@grasp-os/compiler";
import {
  generatedPath,
  generateWorkflow,
  generatorVersion,
  maxSealedPointerLength,
} from "@grasp-os/open-workflow/generate";
import type { CheckedWorkflow } from "@grasp-os/open-workflow/validate";
import { releaseArtifactSchema } from "@grasp-os/shared/app-releases";
import type { ReleaseArtifact } from "@grasp-os/shared/app-releases";
import { sha256Hex, sha256HexOfBytes } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  openWorkflowProtocol,
  workflowResourceErrors,
} from "@grasp-os/shared/workflow-resources";
import type { WorkflowVersionBuild } from "@grasp-os/shared/workflow-resources";
import { and, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { artifactKey, reserveArtifacts } from "./app-releases.ts";
import {
  sdkReleaseArtifacts,
  workflowResourceVersions,
} from "./db/core/schema.ts";
import { releaseReservations } from "./release-retention.ts";
import { buildOpenWorkflow, withinBuildWait } from "./screens.ts";

// What a JSON workflow's version runs (platform specification 13.1, 19.1):
// its definition, validated at publication, lowered into SDK TypeScript
// (@grasp-os/open-workflow's generate.ts), type-checked and compiled into
// JavaScript by the screen compiler, as App code is, and sealed with the
// version: the original JSON, the generated code, the compiled module, the
// expression table it names its expressions from, a source map and the SDK
// modules it was compiled against, each a content-addressed artifact
// (`release-artifacts/<sha256>`, as an App release's) named by the
// version's manifest. A run loads exactly those bytes, every hash checked;
// nothing is generated or compiled when a run starts or resumes.
//
// Threat model, and how each is closed:
//
// - An artifact that isn't its version's. The manifest names each
//   artifact by its SHA-256 and size, and the manifest is the version's
//   row, written once and hashed (`manifest_hash`, which every start pins
//   and immutability triggers keep). Loading checks the manifest against
//   its hash and the pin, every artifact against its entry, and the build's
//   executable identity against the artifacts (`workflow.version_corrupt`
//   otherwise, logged): bytes swapped in storage, a manifest edited, or a
//   start of one version loading another's code all fail closed.
// - Generated code changed after publication, or by the runtime. Bytes are
//   stored under their own hash, so anything written later is another
//   artifact no manifest names; the runtime has no write path to them.
// - A build of a newer SDK under an old manifest. The SDK modules the code
//   was compiled against are sealed with it and loaded from the seal, never
//   from what the host serves now; a build for a protocol this host
//   doesn't speak is refused as such (`workflow.protocol_unsupported`).
// - Bytes a sealed version names deleted by retention. They are reserved
//   for the version (`sdk_release_artifacts`) before they are stored, the
//   version row is written only while every reservation stands, and the
//   retention sweep never takes a reservation of a workflow version
//   (release-retention.ts): versions are never deleted.
// - Injection through the definition into code, and code reaching past
//   the SDK: closed by the generator (literals only, expressions by
//   number) and the compiler (generated code may import the open-workflow
//   SDK alone); see generate.ts.

/** Where the definition, exactly as published, is among the artifacts. */
const definitionArtifact = "source/workflow.json";
/** The tasks and the expression table the generated module names. */
const tasksArtifact = "tasks.json";
/** Where each task's statement is in the generated module. */
const sourceMapArtifact = "source-map.json";
/** Where the compiled module and the SDK modules are among the artifacts. */
const moduleDir = "modules/";
const sdkDir = "sdk/";

/**
 * The generated module's flat name, as the compiler names it and core's
 * run module imports it.
 */
export const generatedModule = appModuleName(openWorkflowEntry);

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

/** Most constructs a non-executable build names (generate.ts's cap). */
const maxUnsupported = 20;

/** A version's build, as its manifest seals it. */
export const sealedBuildSchema = z.discriminatedUnion("executable", [
  z.strictObject({
    executable: z.literal(true),
    generator: z.string().min(1).max(64),
    protocol: z.int().positive(),
    compilerVersion: z.string().min(1).max(128),
    /** The executable identity: see `identityOf`. */
    hash: sha256Schema,
    artifacts: z.array(releaseArtifactSchema).min(1).max(256),
  }),
  z.strictObject({
    executable: z.literal(false),
    unsupported: z
      .array(
        z.strictObject({
          pointer: z.string().max(maxSealedPointerLength),
          taskId: z.string().max(64).nullable(),
          feature: z.string().max(128),
        })
      )
      .min(1)
      .max(maxUnsupported),
  }),
]);

export type SealedBuild = z.infer<typeof sealedBuildSchema>;

/** One task the generated module runs, as the host checks its steps. */
const sealedTaskSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    id: z.string().min(1).max(64),
    kind: z.literal("set"),
    pointer: z.string().max(maxSealedPointerLength),
  }),
  z.strictObject({
    id: z.string().min(1).max(64),
    kind: z.literal("wait"),
    pointer: z.string().max(maxSealedPointerLength),
    /** How long it waits, as its statement says. */
    milliseconds: z.int().positive(),
  }),
]);

/** One expression of the sealed table. */
const sealedExpressionSchema = z.strictObject({
  slot: z.int().min(0),
  pointer: z.string().max(maxSealedPointerLength),
  taskId: z.string().min(1).max(64),
  stage: z.literal("taskDefinition"),
  source: z.string().max(8192),
});

const tasksFileSchema = z.strictObject({
  tasks: z.array(sealedTaskSchema).max(10_000),
  expressions: z.array(sealedExpressionSchema).max(10_000),
});

export type SealedTask = z.infer<typeof sealedTaskSchema>;
export type SealedExpression = z.infer<typeof sealedExpressionSchema>;

/**
 * The executable identity of a build: its generator, protocol, compiler and
 * every artifact it runs (the generated and compiled code, the expression
 * table, the SDK), not the definition's text or the source map, whose
 * labels and layout change nothing that runs. So two definitions that
 * lower to the same program have the same identity.
 */
const identityOf = async (build: {
  generator: string;
  protocol: number;
  compilerVersion: string;
  artifacts: readonly ReleaseArtifact[];
}): Promise<string> =>
  await sha256Hex(
    canonicalJson({
      generator: build.generator,
      protocol: build.protocol,
      compilerVersion: build.compilerVersion,
      artifacts: build.artifacts
        .filter(
          ({ path }) =>
            path !== definitionArtifact && path !== sourceMapArtifact
        )
        .map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
    })
  );

const encoder = new TextEncoder();

/** A version's build as compiled for publication: its seal and its bytes. */
export interface CompiledBuild {
  readonly build: SealedBuild;
  /** Each artifact's bytes, by its SHA-256; none for a build that isn't executable. */
  readonly bytes: ReadonlyMap<string, Uint8Array>;
}

/**
 * Compiles `checked` (published as `definition`, its exact text) into a
 * build: generated, built in the compiler's isolate and hashed, nothing
 * stored yet. A definition with constructs the generator doesn't lower
 * makes a build that isn't executable, naming them. Generated code that
 * doesn't build is the platform's fault, never the definition's: it is
 * logged and refused (`workflow.build_failed`), and nothing is published.
 */
export const compileWorkflow = async (
  env: Env,
  checked: CheckedWorkflow,
  definition: string,
  /** Whose build it is: the workflow resource's ID. */
  whose: string
): Promise<CompiledBuild> => {
  const generated = generateWorkflow(checked);
  if (!generated.ok) {
    return {
      build: {
        executable: false,
        unsupported: generated.unsupported.map((construct) => ({
          pointer: construct.pointer,
          taskId: construct.taskId ?? null,
          feature: construct.feature,
        })),
      },
      bytes: new Map(),
    };
  }
  // A build that runs past the build wait, or whose isolate gave up (its
  // CPU on a large module, or any stop of the sandbox host's: CPU, memory,
  // a crash, its deadline, never cached, screens.ts), is the platform's to
  // finish, never the definition's fault: the publication is refused as
  // one to try again (`workflow.build_slow`), and a late build runs on and
  // is cached for it.
  let built: Awaited<ReturnType<typeof buildOpenWorkflow>> | "late";
  try {
    built = await withinBuildWait(
      env,
      async () =>
        await buildOpenWorkflow(
          env,
          { [openWorkflowEntry]: generated.source },
          whose
        )
    );
  } catch (error) {
    // A refusal of the platform's own (no bounded compiler here) stays one.
    if (isExpectedError(error)) {
      throw error;
    }
    log.warn("workflow.build_unfinished", errorFields(error));
    built = "late";
  }
  if (built === "late") {
    throw workflowResourceErrors.create("workflow.build_slow");
  }
  if (!built.ok) {
    const [first] = built.diagnostics;
    log.error("workflow.build_failed", {
      diagnostics: built.diagnostics.length,
      rule: first?.rule,
      line: first?.line,
      message: first?.message.slice(0, 300),
    });
    throw workflowResourceErrors.create("workflow.build_failed");
  }
  const sdk = await workflowSdkModules(env.ASSETS);
  const texts = new Map<string, string>([
    [definitionArtifact, definition],
    [generatedPath, generated.source],
    [
      tasksArtifact,
      canonicalJson({
        tasks: generated.tasks.map(({ id, kind, pointer, milliseconds }) => ({
          id,
          kind,
          pointer,
          ...(milliseconds === undefined ? {} : { milliseconds }),
        })),
        expressions: generated.expressions.map((expression) => ({
          ...expression,
        })),
      }),
    ],
    [
      sourceMapArtifact,
      canonicalJson({
        generated: generatedPath,
        tasks: generated.tasks.map(({ id, pointer, line }) => ({
          id,
          pointer,
          line,
        })),
      }),
    ],
  ]);
  for (const [name, code] of Object.entries(built.modules)) {
    texts.set(`${moduleDir}${name}`, code);
  }
  for (const [name, code] of Object.entries(sdk.modules)) {
    texts.set(`${sdkDir}${name}`, code);
  }
  const artifacts: ReleaseArtifact[] = [];
  const bytes = new Map<string, Uint8Array>();
  for (const [path, text] of [...texts].toSorted(([a], [b]) =>
    a < b ? -1 : 1
  )) {
    const encoded = encoder.encode(text);
    // oxlint-disable-next-line no-await-in-loop -- a few dozen, in order
    const sha256 = await sha256HexOfBytes(encoded);
    artifacts.push({ path, sha256, bytes: encoded.byteLength });
    bytes.set(sha256, encoded);
  }
  const identity = {
    generator: generatorVersion,
    protocol: openWorkflowProtocol,
    compilerVersion,
    artifacts,
  };
  return {
    build: { executable: true, ...identity, hash: await identityOf(identity) },
    bytes,
  };
};

/**
 * Stores `compiled`'s bytes for version `version` of workflow `id`:
 * reserved for it first (release-retention.ts), so no sweep deletes what it
 * names, then each under its hash. Before the version's row is written,
 * which requires every reservation to stand.
 */
export const storeBuild = async (
  env: Env,
  key: { id: string; version: number },
  compiled: CompiledBuild
): Promise<void> => {
  if (!compiled.build.executable) {
    return;
  }
  await reserveArtifacts(
    env,
    { app: key.id, version: key.version },
    compiled.build.artifacts.map(({ sha256 }) => sha256)
  );
  // Every upload settled before any failure is thrown: a caller that then
  // gives the reservations back must never race an upload still running,
  // which would store bytes no reservation tracks.
  const stored = await Promise.allSettled(
    [...compiled.bytes].map(async ([sha256, bytes]) => {
      await env.FILES.put(artifactKey(sha256), bytes, { sha256 });
    })
  );
  const failed = stored.find((result) => result.status === "rejected");
  if (failed !== undefined) {
    throw failed.reason;
  }
};

/**
 * Whose reservations one publication of workflow `workflowId` makes: its
 * own, never another's, so publications of the same version at once never
 * give back what another still needs (`releaseBuild`). The version's row
 * adopts them as it is written (`adoptReservations`); one that never is
 * gives them back, and the sweep takes any a stopped publication left once
 * its grace is over (release-retention.ts: neither a release nor a version
 * keeps them).
 */
export const publicationReservation = (workflowId: string): string =>
  `${workflowId}~publication~${crypto.randomUUID()}`;

/**
 * The statements that hand publication `owner`'s reservations for version
 * `version` to workflow `workflowId`'s version, in the batch that writes
 * its row: what the version names stays reserved as long as it is.
 */
export const adoptReservations = (
  db: DrizzleD1Database,
  owner: string,
  workflowId: string,
  version: number
) => {
  const reserved = sdkReleaseArtifacts;
  const own = and(eq(reserved.appId, owner), eq(reserved.version, version));
  return [
    db
      .insert(reserved)
      .select(
        db
          .select({
            sha256: reserved.sha256,
            appId: sql<string>`${workflowId}`.as("app_id"),
            version: reserved.version,
            reservedAt: reserved.reservedAt,
          })
          .from(reserved)
          .where(own)
      )
      .onConflictDoNothing(),
    db.delete(reserved).where(own),
  ] as const;
};

/**
 * Gives back what `storeBuild` reserved for publication `owner` (key.id)
 * of version `version` once its row wasn't written (another publication
 * won the number, the workflow went, or storing failed): all of its own
 * reservations, and only those, so another publication's, and what a
 * saved version adopted, stay.
 */
export const releaseBuild = async (
  env: Env,
  key: { id: string; version: number },
  compiled: CompiledBuild
): Promise<void> => {
  if (!compiled.build.executable) {
    return;
  }
  const reserved = sdkReleaseArtifacts;
  await releaseReservations(
    env,
    sql`${reserved.appId} = ${key.id} AND ${reserved.version} = ${key.version}`
  );
};

/** What a version's answer says of its build (`WorkflowVersionBuild`). */
export const buildSummary = (build: SealedBuild): WorkflowVersionBuild =>
  build.executable
    ? { executable: true, hash: build.hash }
    : {
        executable: false,
        unsupported: build.unsupported.map((construct) => ({ ...construct })),
      };

/** Where a version's manifest holds its build. */
const manifestBuildSchema = z.object({ build: sealedBuildSchema });

/** The build a version's manifest text seals. */
export const buildOf = (manifest: string): SealedBuild =>
  manifestBuildSchema.parse(JSON.parse(manifest)).build;

/** A version's executable build, loaded and verified, as a run runs it. */
export interface LoadedBuild {
  readonly hash: string;
  /** The compiled generated module, by flat name. */
  readonly modules: Readonly<Record<string, string>>;
  /** The SDK modules it was compiled against, by flat name. */
  readonly sdk: Readonly<Record<string, string>>;
  readonly tasks: readonly SealedTask[];
  readonly expressions: readonly SealedExpression[];
  /** The generated TypeScript, for export. */
  readonly source: string;
}

const corrupt = (id: string, version: number, what: string): Error => {
  log.error("workflow.build_corrupt", { workflow: id, version, what });
  return workflowResourceErrors.create("workflow.version_corrupt");
};

/** The text of artifact `entry`, checked against its hash and size. */
const artifactText = async (
  env: Env,
  entry: ReleaseArtifact
): Promise<string | undefined> => {
  const object = await env.FILES.get(artifactKey(entry.sha256));
  const bytes = object === null ? undefined : await object.arrayBuffer();
  if (
    bytes === undefined ||
    bytes.byteLength !== entry.bytes ||
    (await sha256HexOfBytes(bytes)) !== entry.sha256
  ) {
    return undefined;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    bytes
  );
};

/** Builds loaded and verified, by manifest hash: a version never changes. */
const verified = new Map<string, Promise<LoadedBuild>>();
const verifiedMax = 32;

const verifiedBuild = async (
  env: Env,
  id: string,
  version: number,
  build: SealedBuild
): Promise<LoadedBuild> => {
  if (!build.executable) {
    throw corrupt(id, version, "not executable");
  }
  if (build.protocol !== openWorkflowProtocol) {
    throw workflowResourceErrors.create("workflow.protocol_unsupported");
  }
  if ((await identityOf(build)) !== build.hash) {
    throw corrupt(id, version, "identity");
  }
  const modules: Record<string, string> = {};
  const sdk: Record<string, string> = {};
  let tasksText: string | undefined;
  let source: string | undefined;
  for (const entry of build.artifacts) {
    // One after the other: a build has a few dozen, and a failure stops
    // the rest.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const text = await artifactText(env, entry);
    if (text === undefined) {
      throw corrupt(id, version, entry.path);
    }
    if (entry.path.startsWith(moduleDir)) {
      modules[entry.path.slice(moduleDir.length)] = text;
    } else if (entry.path.startsWith(sdkDir)) {
      sdk[entry.path.slice(sdkDir.length)] = text;
    } else if (entry.path === tasksArtifact) {
      tasksText = text;
    } else if (entry.path === generatedPath) {
      source = text;
    }
  }
  const tasks =
    tasksText === undefined
      ? undefined
      : tasksFileSchema.safeParse(JSON.parse(tasksText)).data;
  if (
    tasks === undefined ||
    source === undefined ||
    !Object.hasOwn(modules, generatedModule)
  ) {
    throw corrupt(id, version, "contents");
  }
  // Each slot is its index, so the table is read by number only.
  if (tasks.expressions.some(({ slot }, index) => slot !== index)) {
    throw corrupt(id, version, "expression table");
  }
  // Shared by every load of the version in this isolate: frozen, so no
  // caller changes what another runs.
  return Object.freeze({
    hash: build.hash,
    modules: Object.freeze(modules),
    sdk: Object.freeze(sdk),
    tasks: Object.freeze(tasks.tasks.map((task) => Object.freeze(task))),
    expressions: Object.freeze(
      tasks.expressions.map((expression) => Object.freeze(expression))
    ),
    source,
  });
};

/**
 * The executable build of version `version` of workflow `id`, verified:
 * its manifest against its hash and, with `pinned`, the manifest hash a
 * start froze; then every artifact against its entry, and the build's
 * identity against them (`workflow.version_corrupt` otherwise, and for a
 * version that isn't executable, which nothing should load).
 */
export const loadWorkflowBuild = async (
  env: Env,
  id: string,
  version: number,
  pinned?: string
): Promise<LoadedBuild> => {
  const row = await drizzle(env.DB)
    .select({
      manifest: workflowResourceVersions.manifest,
      manifestHash: workflowResourceVersions.manifestHash,
    })
    .from(workflowResourceVersions)
    .where(
      and(
        eq(workflowResourceVersions.workflowResourceId, id),
        eq(workflowResourceVersions.version, version)
      )
    )
    .get();
  if (row === undefined) {
    throw workflowResourceErrors.create("workflow.version_not_found");
  }
  const hash = await sha256Hex(row.manifest);
  if (hash !== row.manifestHash || (pinned !== undefined && pinned !== hash)) {
    throw corrupt(id, version, "manifest");
  }
  let loading = verified.get(hash);
  if (loading === undefined) {
    let build: SealedBuild;
    try {
      build = buildOf(row.manifest);
    } catch {
      throw corrupt(id, version, "build");
    }
    loading = verifiedBuild(env, id, version, build);
    verified.set(hash, loading);
    if (verified.size > verifiedMax) {
      const [oldest] = verified.keys();
      if (oldest !== undefined) {
        verified.delete(oldest);
      }
    }
  }
  try {
    return await loading;
  } catch (error) {
    verified.delete(hash);
    throw error;
  }
};
