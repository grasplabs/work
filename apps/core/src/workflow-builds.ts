import {
  appModuleName,
  compilerVersion,
  generatedWorkflowEntry,
  packageModulePrefix,
  workflowSdkModules,
} from "@grasp-os/compiler";
import { releaseArtifactSchema } from "@grasp-os/shared/app-releases";
import type { ReleaseArtifact } from "@grasp-os/shared/app-releases";
import { diagnosticCategory } from "@grasp-os/shared/diagnostics";
import { sha256Hex, sha256HexOfBytes } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { packageLimits } from "@grasp-os/shared/packages";
import { sharedRun } from "@grasp-os/shared/shared-runs";
import type { SharedRun } from "@grasp-os/shared/shared-runs";
import {
  actionUsesSchema,
  workflowModuleLimits,
} from "@grasp-os/shared/workflow-modules";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import type { WorkflowVersionBuild } from "@grasp-os/shared/workflow-resources";
import type { CheckedWorkflow } from "@grasp-os/workflow-schema/check";
import {
  generateWorkflow,
  generatorVersion,
  taskAtLine,
} from "@grasp-os/workflow-schema/generate";
import { sealedTableSchema } from "@grasp-os/workflow-schema/sealed";
import type {
  SealedExpression,
  SealedTable,
  SealedTask,
} from "@grasp-os/workflow-schema/sealed";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { workflowResourceVersions } from "./db/core/schema.ts";
import { buildGeneratedWorkflow, withinBuildWait } from "./pages.ts";
import {
  artifactKey,
  generationsOf,
  releaseSeal,
  storeArtifacts,
} from "./sealed-artifacts.ts";
import { sealedUse } from "./workflow-modules.ts";
import type { ComputeContract, CompiledModules } from "./workflow-modules.ts";
import { manifestPackagesSchema } from "./workflows/package-seal.ts";

// What a JSON workflow's version runs (platform specification 13.1, 19.1):
// its definition, checked at publication, translated into TypeScript on
// `@grasp-os/sdk/workflow` (@grasp-os/workflow-schema's generate.ts),
// type-checked and compiled into
// JavaScript by the App compiler, as App code is, and sealed with the
// version: the original JSON, the generated code, the compiled module, the
// expression table it names its expressions from, a source map and the SDK
// modules it was compiled against, each a content-addressed artifact
// (sealed-artifacts.ts, as an App release's) named by the version's
// manifest. A run loads exactly those bytes, every hash checked;
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
//   from what the host serves now; a build this host doesn't read, as
//   one an earlier platform release published, is refused as such
//   (`workflow.format_unsupported`), to publish again.
// - A table holding what the run host has no rule for. The sealed table
//   loads only as the generator writes it (@grasp-os/workflow-schema's
//   sealed.ts, `sealedTableSchema`); anything else is
//   `workflow.version_corrupt`.
// - Bytes a sealed version names deleted. Its seal references every
//   artifact it names before uploading them, the version row is written
//   only while every reference stands, versions are never deleted, and an
//   artifact is collected only once nothing references it
//   (sealed-artifacts.ts).
// - Injection through the definition into code, and code reaching past
//   the SDK: closed by the generator (literals only, expressions printed
//   from their checked syntax tree) and the compiler (generated code may
//   import `@grasp-os/sdk/workflow` alone); see generate.ts.
// - A load whose request is cancelled mid-read (workerd never settles it)
//   holds every later load of that version in the isolate, or a load that
//   failed or ran on past its time is served as verified: loads of one
//   build share one only for as long as a load may take (`sharedRun`), and
//   only a load that verified every byte keeps its build (`verified`); a
//   failure keeps nothing (`loadWorkflowBuild`).
// - The workflow's own compute modules changed or swapped. Their source,
//   compiled code and contracts are artifacts of the build like the rest,
//   the compiled code and contracts covered by its identity; loading
//   checks every compute task names a sealed contract of a sealed module
//   (`loadedModules`). Running them is workflow-modules.ts's.

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
 * The workflow's own compute modules: their source as published (export
 * only, so outside the identity, as the definition is), their compiled
 * code, and the contracts read from them (workflow-modules.ts).
 */
const sourceDir = "source/";
const moduleSourceDir = `${sourceDir}code/`;
const computeDir = "compute/";
const computeArtifact = "compute.json";

/**
 * The generated module's flat name, as the compiler names it and core's
 * run module imports it.
 */
export const generatedModule = appModuleName(generatedWorkflowEntry);

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * A version's build, as its manifest seals it: every definition that
 * passes generates (`generateWorkflow`), so every version has one.
 */
export const sealedBuildSchema = z.strictObject({
  generator: z.string().min(1).max(64),
  compilerVersion: z.string().min(1).max(128),
  /** The executable identity: see `identityOf`. */
  hash: sha256Schema,
  artifacts: z.array(releaseArtifactSchema).min(1).max(256),
});

export type SealedBuild = z.infer<typeof sealedBuildSchema>;

/**
 * The tasks `compiled` seals (`tasks.json`), read from its own bytes before
 * anything is stored. For a review of the version a publication answers.
 */
export const compiledTasksOf = (
  compiled: CompiledBuild
): readonly SealedTask[] => {
  const { build } = compiled;
  const entry = build.artifacts.find(({ path }) => path === tasksArtifact);
  const bytes =
    entry === undefined ? undefined : compiled.bytes.get(entry.sha256);
  if (bytes === undefined) {
    throw new Error("A compiled build holds no tasks.json");
  }
  return sealedTableSchema.parse(JSON.parse(new TextDecoder().decode(bytes)))
    .tasks;
};

/**
 * The executable identity of a build: its generator, compiler and
 * every artifact it runs (the generated and compiled code, the expression
 * table, the SDK), not the definition's text or the source map, whose
 * labels and layout change nothing that runs. So two definitions that
 * lower to the same program have the same identity.
 */
const identityOf = async (build: {
  generator: string;
  compilerVersion: string;
  artifacts: readonly ReleaseArtifact[];
}): Promise<string> =>
  await sha256Hex(
    canonicalJson({
      generator: build.generator,
      compilerVersion: build.compilerVersion,
      artifacts: build.artifacts
        .filter(
          ({ path }) =>
            !path.startsWith(sourceDir) && path !== sourceMapArtifact
        )
        .map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
    })
  );

const encoder = new TextEncoder();

/** A version's build as compiled for publication: its seal and its bytes. */
export interface CompiledBuild {
  readonly build: SealedBuild;
  /** Each artifact's bytes, by its SHA-256. */
  readonly bytes: ReadonlyMap<string, Uint8Array>;
}

/**
 * Compiles `checked` (published as `definition`, its exact text) into a
 * build of workflow `whose`: generated (@grasp-os/workflow-schema's
 * generate.ts), built in the compiler's isolate and hashed, nothing stored
 * yet. Every checked document generates: the format has nothing the
 * generator doesn't lower. Generated code that doesn't build is the
 * platform's fault, never the definition's: it is logged and refused
 * (`workflow.build_failed`), and nothing is published. The workflow's own
 * compute modules (`compiled`, workflow-modules.ts), already built and
 * inspected, are sealed with it.
 */
export const compileWorkflow = async (
  env: Env,
  checked: CheckedWorkflow,
  definition: string,
  /** Whose build it is: the workflow resource's ID. */
  whose: string,
  compiled?: CompiledModules
): Promise<CompiledBuild> => {
  // Named alike for every workflow: the code carries nothing of this
  // deployment (an export packages it), and one document is one program,
  // one build identity, whichever workflow publishes it.
  const generated = generateWorkflow(checked, "workflow");
  // A build that runs past the build wait, or whose isolate gave up (its
  // CPU on a large module, or any stop of the sandbox host's: CPU, memory,
  // a crash, its deadline, never cached, pages.ts), is the platform's to
  // finish, never the definition's fault: the publication is refused as
  // one to try again (`workflow.build_slow`), and a late build runs on and
  // is cached for it.
  let built: Awaited<ReturnType<typeof buildGeneratedWorkflow>> | "late";
  try {
    built = await withinBuildWait(
      env,
      async () =>
        await buildGeneratedWorkflow(
          env,
          { [generatedWorkflowEntry]: generated.source },
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
    // In the definition's terms: the step whose generated code the first
    // diagnostic is in, by its JSON Pointer and ID.
    const task =
      first?.line === undefined
        ? undefined
        : taskAtLine(generated.spans, first.line);
    log.error("workflow.build_failed", {
      diagnostics: built.diagnostics.length,
      rule: first?.rule,
      category:
        first === undefined ? undefined : diagnosticCategory(first.rule),
      line: first?.line,
      pointer: task?.pointer,
      taskId: task?.taskId,
      message: first?.message.slice(0, 300),
    });
    throw workflowResourceErrors.create("workflow.build_failed");
  }
  const sdk = await workflowSdkModules(env.ASSETS);
  const texts = new Map<string, string>([
    [definitionArtifact, definition],
    [generatedWorkflowEntry, generated.source],
    [
      tasksArtifact,
      // The table as the plain JSON it is, read back by `sealedTableSchema`.
      canonicalJson(
        z.json().parse(
          structuredClone({
            tasks: generated.tasks,
            expressions: generated.expressions,
            workflow: generated.workflow,
            params: generated.params,
          })
        )
      ),
    ],
    [
      sourceMapArtifact,
      canonicalJson({
        generated: generatedWorkflowEntry,
        tasks: generated.spans.map(({ taskId, pointer, from, to }) => ({
          id: taskId,
          pointer,
          from,
          to,
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
  if (compiled !== undefined) {
    for (const [path, source] of Object.entries(compiled.sources)) {
      texts.set(`${sourceDir}${path}`, source);
    }
    for (const [name, code] of Object.entries(compiled.modules)) {
      texts.set(`${computeDir}${name}`, code);
    }
    texts.set(
      computeArtifact,
      canonicalJson({
        paths: Object.keys(compiled.sources).toSorted(),
        contracts: Object.fromEntries(
          [...compiled.contracts].map(([key, contract]) => [
            key,
            { ...contract },
          ])
        ),
      })
    );
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
    compilerVersion,
    artifacts,
  };
  return {
    build: { ...identity, hash: await identityOf(identity) },
    bytes,
  };
};

/**
 * References and stores `compiled`'s bytes for seal `seal`, before the row
 * that names the seal is written.
 */
export const storeBuild = async (
  env: Env,
  seal: string,
  compiled: CompiledBuild
): Promise<void> => {
  await storeArtifacts(env, seal, compiled.bytes);
};

/**
 * Gives back what `storeBuild` referenced for seal `seal` once its row wasn't
 * written (another publication won the number, the workflow went, or
 * storing failed), or went (a test run swept).
 */
export const releaseBuild = async (env: Env, seal: string): Promise<void> => {
  await releaseSeal(env, seal);
};

/** What a version's answer says of its build (`WorkflowVersionBuild`). */
export const buildSummary = (build: SealedBuild): WorkflowVersionBuild => ({
  hash: build.hash,
});

/** Where a version's manifest holds its build. */
const manifestBuildSchema = z.object({ build: sealedBuildSchema });

/** What a manifest says of the kinds of its bindings, before anything else. */
const manifestBindingKindsSchema = z.object({
  bindings: z.array(z.object({ kind: z.unknown() })),
});

/**
 * Refuses (`workflow.binding_kind_removed`) a version whose manifest
 * binds a kind the platform no longer serves: an `operation` binding, an
 * App's public store operation, which no workflow reaches now that each
 * App's store is its own. Read before the rest of the manifest, so such a
 * version is told to be published again, never taken for one that was
 * changed (`workflow.version_corrupt`).
 */
export const requireServedBindingKinds = (manifest: unknown): void => {
  const { data } = manifestBindingKindsSchema.safeParse(manifest);
  if (data?.bindings.some(({ kind }) => kind === "operation") === true) {
    throw workflowResourceErrors.create("workflow.binding_kind_removed");
  }
};

/**
 * The build a version's manifest text seals. One binding a kind no longer
 * served is `workflow.binding_kind_removed`, and one of a shape this host
 * doesn't read `workflow.format_unsupported`: its manifest is what an
 * earlier platform release published, to be published again, never taken
 * for one that was changed.
 */
export const buildOf = (manifest: string): SealedBuild => {
  const read: unknown = JSON.parse(manifest);
  requireServedBindingKinds(read);
  const parsed = manifestBuildSchema.safeParse(read);
  if (!parsed.success) {
    throw workflowResourceErrors.create("workflow.format_unsupported");
  }
  return parsed.data.build;
};

/** A version's executable build, loaded and verified, as a run runs it. */
export interface LoadedBuild {
  readonly hash: string;
  /** The compiled generated module, by flat name. */
  readonly modules: Readonly<Record<string, string>>;
  /** The SDK modules it was compiled against, by flat name. */
  readonly sdk: Readonly<Record<string, string>>;
  readonly tasks: readonly SealedTask[];
  readonly expressions: readonly SealedExpression[];
  /** Whether the workflow has an output, evaluated in `workflow:output`. */
  readonly workflow: SealedTable["workflow"];
  /** The parameters its code reads: those not sensitive. */
  readonly params: readonly string[];
  /** The generated TypeScript, for export. */
  readonly source: string;
  /** The workflow's own compute modules (workflow-modules.ts). */
  readonly compute: LoadedModules;
  /**
   * The approved graph its modules import, if any (GRA-665): every start
   * and call admits it again (workflows/sealed-packages.ts). Its entries'
   * modules are among `compute.modules`.
   */
  readonly packages: { readonly graphHash: string } | undefined;
}

/**
 * Whether a build's compute modules hold exactly the package modules its
 * manifest seals (`entries`, by name): each one, no other (none for a
 * version that seals none), within a version's allowance together.
 */
const packagesAgree = (
  modules: Readonly<Record<string, string>>,
  entries: Readonly<Record<string, string>>
): boolean => {
  const sealed = new Set(Object.values(entries));
  const held = Object.keys(modules).filter((name) =>
    name.startsWith(packageModulePrefix)
  );
  const chars = held.reduce(
    (total, name) => total + (modules[name]?.length ?? 0),
    0
  );
  return (
    held.length === sealed.size &&
    held.every((name) => sealed.has(name)) &&
    // The platform's ceiling, not a deployment's: a version sealed under
    // any limit loads.
    chars <= packageLimits.workflowPackageChars
  );
};

/** A version's compute modules, as sealed. */
export interface LoadedModules {
  /** Their compiled code, by flat name. */
  readonly modules: Readonly<Record<string, string>>;
  /** Every module's path (`code/<file>.ts`). */
  readonly paths: readonly string[];
  /** Each calculation's contract, by `code/<file>.ts#<export>`. */
  readonly contracts: ReadonlyMap<string, ComputeContract>;
  /** The modules as published, by path, for export. */
  readonly sources: Readonly<Record<string, string>>;
}

/** A sealed contract's key: `code/<file>.ts#<export>`. */
const sealedContractKey =
  /^(?<module>code\/[^#]+\.ts)#[A-Za-z_$][A-Za-z0-9_$]*$/u;

/** The compute modules' contracts, as `compute.json` seals them. */
const computeFileSchema = z.strictObject({
  paths: z
    .array(z.string().max(workflowModuleLimits.pathChars))
    .max(workflowModuleLimits.files),
  contracts: z
    .record(
      z.string().max(512),
      z.discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("compute"),
          input: z.string().max(workflowModuleLimits.descriptorChars),
          output: z.string().max(workflowModuleLimits.descriptorChars),
        }),
        z.strictObject({
          kind: z.literal("operation"),
          input: z.string().max(workflowModuleLimits.descriptorChars),
          output: z.string().max(workflowModuleLimits.descriptorChars),
          uses: actionUsesSchema,
        }),
      ])
    )
    .refine(
      (contracts) =>
        Object.keys(contracts).length <= workflowModuleLimits.contracts
    ),
});

/**
 * Refuses a build published before seals (`seal` null): of another
 * format, to publish again.
 */
const requireSeal = (seal: string | null): void => {
  if (seal === null) {
    throw workflowResourceErrors.create("workflow.format_unsupported");
  }
};

const corrupt = (id: string, version: number, what: string): Error => {
  log.error("workflow.build_corrupt", { workflow: id, version, what });
  return workflowResourceErrors.create("workflow.version_corrupt");
};

/** The text of artifact `entry`, checked against its hash and size. */
const artifactText = async (
  env: Env,
  generations: ReadonlyMap<string, string>,
  entry: ReleaseArtifact
): Promise<string | undefined> => {
  const generation = generations.get(entry.sha256);
  if (generation === undefined) {
    return undefined;
  }
  const object = await env.FILES.get(artifactKey(entry.sha256, generation));
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

/**
 * The compute modules `text` (`compute.json`, absent for none) seals, with
 * their compiled code and sources: undefined when they don't agree, a
 * module named that the build doesn't hold, or a contract of a module
 * that isn't one.
 */
const loadedModules = (
  text: string | undefined,
  modules: Record<string, string>,
  sources: Record<string, string>
): LoadedModules | undefined => {
  if (text === undefined) {
    return Object.keys(modules).length === 0 &&
      Object.keys(sources).length === 0
      ? Object.freeze({
          modules: Object.freeze({}),
          paths: Object.freeze([]),
          contracts: new Map(),
          sources: Object.freeze({}),
        })
      : undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const file = computeFileSchema.safeParse(parsed).data;
  const compiledAll =
    file !== undefined &&
    file.paths.every(
      (path) =>
        Object.hasOwn(modules, appModuleName(path)) &&
        Object.hasOwn(sources, path)
    );
  const contractsOfPaths =
    file !== undefined &&
    Object.keys(file.contracts).every((key) => {
      // `code/<file>.ts#<export>` exactly, of one of the sealed modules.
      const module = sealedContractKey.exec(key)?.groups?.module;
      return module !== undefined && file.paths.includes(module);
    });
  if (file === undefined || !compiledAll || !contractsOfPaths) {
    return undefined;
  }
  return Object.freeze({
    modules: Object.freeze(modules),
    paths: Object.freeze([...file.paths]),
    contracts: new Map(
      Object.entries(file.contracts).map(([key, contract]) => [
        key,
        Object.freeze({
          ...contract,
          ...(contract.kind === "operation"
            ? {
                uses: Object.freeze(contract.uses.map(sealedUse)),
              }
            : {}),
        }),
      ])
    ),
    sources: Object.freeze(sources),
  });
};

/**
 * Builds loaded and verified, by manifest hash: a version never changes.
 * Only a load that verified the identity and every artifact puts one
 * here, so a failed load leaves nothing, and two loads of one hash can
 * only put the same build.
 */
const verified = new Map<string, LoadedBuild>();
const verifiedMax = 32;

/**
 * The tasks each version's build seals, by manifest hash, for its review:
 * a version never changes. Small, so many more are kept than builds.
 */
const reviewedTasks = new Map<string, readonly SealedTask[]>();
const reviewedTasksMax = 1024;

/**
 * The tasks version `version` of `id` seals, for its review (GRA-727):
 * read from its `tasks.json` alone, hash-checked against the manifest
 * (`manifest`, which the caller has checked against `manifestHash`),
 * never by loading the whole build, so a listing of many versions reads
 * one small file for each, and none twice.
 */
export const reviewedTasksOf = async (
  env: Env,
  id: string,
  version: number,
  manifest: string,
  manifestHash: string,
  seal: string | null
): Promise<readonly SealedTask[]> => {
  const kept =
    verified.get(manifestHash)?.tasks ?? reviewedTasks.get(manifestHash);
  if (kept !== undefined) {
    return kept;
  }
  requireSeal(seal);
  let build: SealedBuild;
  try {
    build = buildOf(manifest);
  } catch (error) {
    if (isExpectedError(error)) {
      throw error;
    }
    throw corrupt(id, version, "build");
  }
  const entry = build.artifacts.find(({ path }) => path === tasksArtifact);
  const text =
    entry === undefined
      ? undefined
      : await artifactText(
          env,
          await generationsOf(env, [entry.sha256]),
          entry
        );
  let tasks: readonly SealedTask[] | undefined;
  try {
    tasks =
      text === undefined
        ? undefined
        : sealedTableSchema.safeParse(JSON.parse(text)).data?.tasks;
  } catch {
    // Sealed bytes that aren't JSON: corrupt, as ones of the wrong shape.
    tasks = undefined;
  }
  if (tasks === undefined) {
    throw corrupt(id, version, tasksArtifact);
  }
  const frozen = Object.freeze(tasks.map((task) => Object.freeze(task)));
  if (reviewedTasks.size >= reviewedTasksMax) {
    const [oldest] = reviewedTasks.keys();
    if (oldest !== undefined) {
      reviewedTasks.delete(oldest);
    }
  }
  reviewedTasks.set(manifestHash, frozen);
  return frozen;
};

/**
 * The loads running now in this isolate, by manifest hash: loads of a
 * build asked for while one runs share it. A load whose request was
 * cancelled while it read never settles, so it is waited for only as long
 * as a load may take (`sharedRun`, `buildReadMs`), never until the build
 * is evicted.
 */
const verifying = new Map<string, SharedRun<LoadedBuild>>();

/**
 * The longest a load of a build takes: its manifest bounds how many
 * artifacts it reads (one R2 read and one hash of each), one after the
 * other, so a base for the first plus a share for each. A real build has
 * a few dozen and loads in well under a second; past this, a load is
 * taken for abandoned and the next to ask reads it anew.
 */
const buildReadBaseMs = 5000;

/** {@link buildReadBaseMs}'s share for each artifact a build reads. */
const buildArtifactReadMs = 100;

/**
 * How long a load of `build` may take before it is taken for abandoned,
 * or less where tests set `WORKFLOW_BUILD_READ_MS`.
 */
const buildReadMs = (env: Env, build: SealedBuild): number => {
  const bound = buildReadBaseMs + build.artifacts.length * buildArtifactReadMs;
  const set = Number(env.WORKFLOW_BUILD_READ_MS);
  return Number.isInteger(set) && set > 0 && set < bound ? set : bound;
};

const verifiedBuild = async (
  env: Env,
  id: string,
  version: number,
  build: SealedBuild
): Promise<Omit<LoadedBuild, "packages">> => {
  if ((await identityOf(build)) !== build.hash) {
    throw corrupt(id, version, "identity");
  }
  const generations = await generationsOf(
    env,
    build.artifacts.map(({ sha256 }) => sha256)
  );
  const modules: Record<string, string> = {};
  const sdk: Record<string, string> = {};
  const computeModules: Record<string, string> = {};
  const moduleSources: Record<string, string> = {};
  let tasksText: string | undefined;
  let computeText: string | undefined;
  let source: string | undefined;
  for (const entry of build.artifacts) {
    // One after the other: a build has a few dozen, and a failure stops
    // the rest.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const text = await artifactText(env, generations, entry);
    if (text === undefined) {
      throw corrupt(id, version, entry.path);
    }
    if (entry.path.startsWith(moduleDir)) {
      modules[entry.path.slice(moduleDir.length)] = text;
    } else if (entry.path.startsWith(sdkDir)) {
      sdk[entry.path.slice(sdkDir.length)] = text;
    } else if (entry.path.startsWith(computeDir)) {
      computeModules[entry.path.slice(computeDir.length)] = text;
    } else if (entry.path.startsWith(moduleSourceDir)) {
      moduleSources[entry.path.slice(sourceDir.length)] = text;
    } else if (entry.path === computeArtifact) {
      computeText = text;
    } else if (entry.path === tasksArtifact) {
      tasksText = text;
    } else if (entry.path === generatedWorkflowEntry) {
      source = text;
    }
  }
  const tasks =
    tasksText === undefined
      ? undefined
      : sealedTableSchema.safeParse(JSON.parse(tasksText)).data;
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
  const compute = loadedModules(computeText, computeModules, moduleSources);
  // Every calculation a task calls is one the seal holds, of a module it
  // compiled: checked once here, so a run never looks one up in vain.
  const callsSealed = tasks.tasks.every((task) => {
    if (
      task.kind !== "call" ||
      (task.call.name !== "grasp.compute" && task.call.name !== "grasp.action")
    ) {
      return true;
    }
    // A calculation's contract for a compute task, an action's for an
    // action task, never the other.
    const sealed = compute?.contracts.get(
      `${task.call.module}#${task.call.export}`
    );
    return (
      sealed?.kind ===
      (task.call.name === "grasp.compute" ? "compute" : "operation")
    );
  });
  if (compute === undefined || !callsSealed) {
    throw corrupt(id, version, "compute modules");
  }
  // Shared by every load of the version in this isolate: frozen, so no
  // caller changes what another runs.
  return Object.freeze({
    hash: build.hash,
    modules: Object.freeze(modules),
    sdk: Object.freeze(sdk),
    tasks: Object.freeze(tasks.tasks.map((task) => Object.freeze(task))),
    workflow: Object.freeze(tasks.workflow),
    params: Object.freeze(tasks.params),
    expressions: Object.freeze(
      tasks.expressions.map((expression) => Object.freeze(expression))
    ),
    source,
    compute,
  });
};

/** `loadWorkflowBuild`'s work, of the manifest `row` keeps. */
const loadSealedBuild = async (
  env: Env,
  id: string,
  version: number,
  row: { manifest: string; manifestHash: string; seal: string | null },
  pinned: string | undefined
): Promise<LoadedBuild> => {
  const hash = await sha256Hex(row.manifest);
  if (hash !== row.manifestHash || (pinned !== undefined && pinned !== hash)) {
    throw corrupt(id, version, "manifest");
  }
  requireSeal(row.seal);
  const kept = verified.get(hash);
  if (kept !== undefined) {
    return kept;
  }
  let build: SealedBuild;
  let packages: z.infer<typeof manifestPackagesSchema>["packages"];
  try {
    build = buildOf(row.manifest);
    ({ packages } = manifestPackagesSchema.parse(JSON.parse(row.manifest)));
  } catch (error) {
    if (isExpectedError(error)) {
      throw error;
    }
    throw corrupt(id, version, "build");
  }
  return await sharedRun(verifying, hash, buildReadMs(env, build), async () => {
    const built = await verifiedBuild(env, id, version, build);
    if (!packagesAgree(built.compute.modules, packages?.entries ?? {})) {
      throw corrupt(id, version, "packages");
    }
    const loaded: LoadedBuild = Object.freeze({
      ...built,
      packages:
        packages === undefined
          ? undefined
          : Object.freeze({ graphHash: packages.graphHash }),
    });
    // A load that ran on past being taken for abandoned keeps what is
    // there already: the same build, as the hash is the same.
    if (!verified.has(hash)) {
      verified.set(hash, loaded);
      if (verified.size > verifiedMax) {
        const [oldest] = verified.keys();
        if (oldest !== undefined) {
          verified.delete(oldest);
        }
      }
    }
    return loaded;
  });
};

/**
 * The executable build of version `version` of workflow `id`, verified:
 * its manifest against its hash and, with `pinned`, the manifest hash a
 * start froze; then every artifact against its entry, and the build's
 * identity against them (`workflow.version_corrupt` otherwise).
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
      seal: workflowResourceVersions.sealId,
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
  return await loadSealedBuild(env, id, version, row, pinned);
};

/**
 * The executable build of a test run of workflow `id`'s draft checkpoint
 * (workflows/candidate-runs.ts), from the manifest its row keeps, verified
 * as a version's is (`loadWorkflowBuild`): the manifest against its hash
 * and the one the run was pinned to, then every artifact, and the build's
 * identity against them.
 */
export const loadCandidateBuild = async (
  env: Env,
  id: string,
  row: { manifest: string; manifestHash: string; reservation: string },
  pinned: string
): Promise<LoadedBuild> =>
  // Version 0: no version's, for what a corrupt build's report names.
  await loadSealedBuild(env, id, 0, { ...row, seal: row.reservation }, pinned);
