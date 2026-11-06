import {
  appCodeFiles,
  appCodeLimitErrors,
  appTestFiles,
  isPageFile,
  buildFiles,
  checkBatches,
  checkCharacters,
  checkedDiagnostics,
  checkKeys,
  checkRecords,
  checkStopped,
  checksInParts,
  compilerVersion,
  kitModuleName,
  kitModules,
  kitPreviewModules,
  previewRuntime,
  pageRuntime,
  limitErrors,
  computeModuleErrors,
  computePackagesFile,
  moduleRecordOf,
  expressionTypeCheck,
  generatedWorkflowErrors,
  pageIncrementKeys,
  pageRefusals,
  pageSources,
  withTypeCheck,
} from "@grasp-os/compiler";
import type {
  AppCodeBuild,
  BuildMetrics,
  CheckRecord,
  CompileTarget,
  Diagnostic,
  InspectTarget,
  ComputeModulesBuild,
  ExpressionScopeTypes,
  ExpressionTypeCheck,
  IncrementalBuild,
  Increments,
  GeneratedWorkflowBuild,
  TypedExpression,
  PageBuild,
  SurfaceManifest,
  TypeCheckPlan,
  TypeCheckRequest,
  Unchecked,
} from "@grasp-os/compiler";
import { diagnosticCategory } from "@grasp-os/shared/diagnostics";
import { sha256Hex } from "@grasp-os/shared/encoding";
import type { ErrorPayload } from "@grasp-os/shared/errors";
import { canonicalJson, canonicalText } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { pageErrors } from "@grasp-os/shared/pages";
import { sharedRun } from "@grasp-os/shared/shared-runs";
import type { SharedRun } from "@grasp-os/shared/shared-runs";
import { z } from "zod";

import { batchesOf, callSplitting } from "./batches.ts";
import {
  forgetReceipts,
  keySchema,
  lastUsedOf,
  refreshKept,
  sweepReceipts,
  throughCache,
  usedNow,
} from "./build-cache.ts";
import type { Built, CacheEnv } from "./build-cache.ts";
import {
  checksPrefix,
  incrementPrefixes,
  keepChecks,
  keepIncrements,
  readChecks,
  readIncrements,
} from "./module-cache.ts";
import type { IncrementKeys } from "./module-cache.ts";
import type { FrameCode } from "./page-frame.ts";
import { PlatformBoundError, platformRunner } from "./platform-sandbox.ts";
import type { PlatformEnv, PlatformRunner } from "./platform-sandbox.ts";

/**
 * The longest anything waits for one build. A warm build takes
 * milliseconds to a few hundred; a first one after a deploy starts the
 * compiler, about a second. The compiler bounds a build's CPU, not how
 * long it takes, so this is what keeps a build that never answers from
 * holding a save, an open, a review or a preview. A chat's check builds
 * this way too (agent-builds.ts), in a code run that has 30 seconds and
 * runs the tests after the builds, so the wait leaves it room.
 */
export const buildWaitMs = 15_000;

/** The build wait: {@link buildWaitMs}, or less where tests set `BUILD_WAIT_MS`. */
const buildWaitOf = (env: Env): number => {
  const set = Number(env.BUILD_WAIT_MS);
  return Number.isInteger(set) && set > 0 && set < buildWaitMs
    ? set
    : buildWaitMs;
};

/**
 * What `run` (a build) answers within the build wait, or `late`: every
 * build anything waits on goes through this. A late build runs on, and
 * caches what it builds for the next to ask.
 */
export const withinBuildWait = async <T>(
  env: Env,
  run: () => Promise<T>
): Promise<T | "late"> =>
  await Promise.race([
    run(),
    scheduler.wait(buildWaitOf(env)).then(() => "late" as const),
  ]);

/** A hash of an App's files, whatever order they come in. */
const hashOf = async (files: Record<string, string>): Promise<string> =>
  await sha256Hex(
    JSON.stringify(
      Object.entries(files).toSorted(([a], [b]) => (a < b ? -1 : 1))
    )
  );

/** An App's files at one version, by path. */
type AppFiles = Record<string, string>;

/**
 * What a build is: the compiler that builds it (a release with a new
 * compiler or kit builds every App again) and a hash of the files it
 * reads. Nothing else goes into a build, so the same files build the same
 * whichever App or version they are in: an App made from a blueprint, or
 * a version that changed only its pages, takes the workflow build it
 * already has.
 */
export const buildKey = async (files: AppFiles): Promise<string> =>
  `${compilerVersion}/${await hashOf(files)}`;

/** What a build of `kind` takes, as its errors past it. */
const limitsOf = (kind: string): ((files: AppFiles) => Diagnostic[]) => {
  // An App's server code carries the host's generated modules, held to
  // their own allowance, so they never count against the App's limits.
  if (kind === "app" || kind === "app-check" || kind === "workflow") {
    return appCodeLimitErrors;
  }
  // A JSON workflow's generated module: one file, held to its own bound.
  if (kind === "generated-workflow") {
    return generatedWorkflowErrors;
  }
  // A JSON workflow's compute modules: held to their own bounds, the list
  // of approved packages core names beside them apart (`computePackagesFile`).
  if (kind === "compute") {
    return ({ [computePackagesFile]: _packages, ...modules }) =>
      computeModuleErrors(modules);
  }
  return limitErrors;
};

/** A build refused before it started, or one that failed. */
interface FailedBuild {
  ok: false;
  diagnostics: Diagnostic[];
}

/** What building reads from core's env. */
export type BuildEnv = PlatformEnv &
  CacheEnv &
  Pick<Env, "BUILD_BATCH_CPU_MS" | "TYPE_CHECK_CHARACTERS"> & {
    /** Where builds are cached: core's R2 bucket, in the EU. */
    FILES: Pick<R2Bucket, "get" | "put">;
  };

/** How much longer than a build may take a build's lease is held. */
export const leaseSlackMs = 30_000;

/**
 * Which build profile a build is for (spec 19.2.1): `production`, what a
 * version's saves, reviews, seals and opens build; `preview`, what a
 * chat's draft builds, checks and seals. Each profile has cache keys and
 * page artifact hashes of its own, so a preview build never stands in
 * for a production one, even of the same files.
 */
export type BuildProfile = "preview" | "production";

/** How a build is asked for. */
export interface BuildOptions {
  /** Its profile: `production` unless a chat's draft asks. */
  readonly profile?: BuildProfile;
  /** Given up on: no compile starts, and it throws its reason. */
  readonly signal?: AbortSignal;
  /**
   * False for a preview's frame alone: its pages are built without the
   * type check (the compiler's `preview-frame`), which would hold up what
   * the person sees and gate nothing it runs. The agent's check of the
   * draft builds them with it.
   */
  readonly checks?: boolean;
}

/**
 * What the compiler (`AppCompiler`) runs for each kind of build: its
 * method and the target. Only inspection (`app`, the server code with
 * stand-in generated modules) is `inspect`; a seal's checked server code
 * (`app-check`) is `build("app")`, with every gate.
 */
const compilerCalls = {
  page: ["build", "pages"],
  app: ["inspect", "app"],
  "app-check": ["build", "app"],
  "app-tests": ["build", "app-tests"],
  "generated-workflow": ["build", "generated-workflow"],
  compute: ["build", "compute"],
} as const satisfies Record<
  string,
  readonly ["build", CompileTarget] | readonly ["inspect", InspectTarget]
>;

/** The kinds of build, by the compiler call each runs. */
type BuildKind = keyof typeof compilerCalls;

/**
 * The compiler call a build of `kind` for `profile` runs: a chat's draft's
 * pages are built instrumented for React Fast Refresh, on the preview
 * kit (spec 19.2.1); every other build is the same for both profiles.
 */
const compilerCallOf = (
  kind: BuildKind,
  profile: BuildProfile,
  checks = true
):
  | (typeof compilerCalls)[BuildKind]
  | readonly ["build", "preview-pages" | "preview-frame"] => {
  if (kind !== "page" || profile !== "preview") {
    return compilerCalls[kind];
  }
  return checks ? ["build", "preview-pages"] : ["build", "preview-frame"];
};

/**
 * Whether the compiler's answer is shaped as a build: its code is core's
 * own, which reads the App's source and never runs it, so its answer is
 * trusted as the Loader's is; only a broken one is refused.
 */
const isBuildShaped = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  "ok" in value &&
  (value.ok === true ||
    (value.ok === false &&
      "diagnostics" in value &&
      Array.isArray(value.diagnostics)));

const day = 24 * 60 * 60 * 1000;

/**
 * How long a cached build is kept after it was last used: the clock's
 * sweep deletes what is older (`sweepBuilds`). A build is the compiler's
 * output for files core keeps, under its version, so one swept is built
 * again, the same, the next time it is asked for: what runs never rests
 * on the cache. Builds of an older compiler are never asked for again,
 * and go once their time is up.
 */
export const buildKeepMs = 30 * day;

/**
 * How old a cached build may be and still be served as it is: past this,
 * serving it writes it again (`cachedBuild`), so one in use never reaches
 * `buildKeepMs`.
 */
export const buildRefreshMs = buildKeepMs / 2;

/** What a build holds while it runs: whose it is, its lease, and where it keeps what it may reuse. */
interface BuildLease {
  env: BuildEnv;
  whose: string;
  leaseMs: number;
  /** Renews the build's lease, as each call starts. */
  renew: () => Promise<void>;
}

/** The most characters one run of tsrs reads: `checkCharacters`, or fewer where tests set `TYPE_CHECK_CHARACTERS`. */
const checkCharactersOf = (env: BuildEnv): number => {
  const set = Number(env.TYPE_CHECK_CHARACTERS);
  return Number.isInteger(set) && set > 0 && set < checkCharacters
    ? set
    : checkCharacters;
};

/**
 * How many parts a check of an App too large for one run takes between
 * keeping what they said: a few seconds of checking, so a build stopped
 * part way resumes from close to where it stopped, in a handful of
 * writes however many parts it takes.
 */
const partsPerKeep = 25;

/** One run of the type checker's isolate over `request`: its diagnostics. */
const checkerRun = async (
  runner: PlatformRunner,
  request: TypeCheckRequest,
  renew: () => Promise<void>
): Promise<Diagnostic[]> => {
  await renew();
  const diagnostics = await runner.run("type-checker", "check", [request]);
  if (!Array.isArray(diagnostics)) {
    throw new TypeError(
      "The type checker answered something else than diagnostics."
    );
  }
  // SAFETY: the checker's answer, core's own code, checked an array.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return diagnostics as Diagnostic[];
};

/**
 * What a check of the whole of `plan`'s files says. Within what one run
 * of tsrs reads (`checkCharacters`), one call over every file, keeping
 * nothing, as ever. Larger, a part at a time (the compiler's
 * check-plan.ts): what the App's earlier checks of the target said of a
 * file is reused where it was kept under the key of everything the file's
 * check reads, and the files with none are checked in parts that each
 * hold their closures, one checker call each. What they said is kept in
 * one object per App and target, every `partsPerKeep` parts and at the
 * end. So a write checks only what it can change, and no part reads much
 * more than the largest page and what it pulls in. A plan without a graph
 * is checked whole. A part whose check stopped is kept for none of its
 * files: its stop is said, and the next build checks it again.
 */
const typeChecked = async (
  runner: PlatformRunner,
  { request, graph }: TypeCheckPlan,
  { env, whose, leaseMs, renew }: BuildLease
): Promise<Diagnostic[]> => {
  const most = checkCharactersOf(env);
  if (graph === undefined || !checksInParts(request, most)) {
    return await checkerRun(runner, request, renew);
  }
  const paths = Object.keys(request.files);
  const { keys, closures } = await checkKeys(request, graph);
  const set = await sha256Hex(
    JSON.stringify([whose, request.options, request.allowed ?? null])
  );
  const kept =
    keys === undefined
      ? new Map<string, CheckRecord>()
      : await readChecks(env, set, buildRefreshMs);
  const records = new Map<string, CheckRecord>();
  for (const path of paths) {
    const record = kept.get(keys?.[path] ?? "");
    if (record?.path === path) {
      records.set(path, record);
    }
  }
  const due = paths.filter((path) => !records.has(path));
  // What may be kept: by the key of each file whose check didn't stop.
  const keeping = new Map<string, CheckRecord>();
  const keep = async (): Promise<void> => {
    if (keys === undefined) {
      return;
    }
    for (const [path, record] of records) {
      const key = keys[path];
      if (key !== undefined && !checkStopped(record.program)) {
        keeping.set(key, record);
      }
    }
    await keepChecks(env, set, keeping, leaseMs);
  };
  let parts = 0;
  for (const part of checkBatches(request, closures, due, most)) {
    parts += 1;
    // oxlint-disable-next-line no-await-in-loop -- one part at a time: each takes an isolate's memory
    const diagnostics = await checkerRun(runner, part, renew);
    for (const record of checkRecords(Object.keys(part.files), diagnostics)) {
      if (!records.has(record.path)) {
        records.set(record.path, record);
      }
    }
    if (parts % partsPerKeep === 0) {
      // oxlint-disable-next-line no-await-in-loop -- kept part way, so a build stopped later resumes from it
      await keep();
    }
  }
  if (parts % partsPerKeep !== 0) {
    await keep();
  }
  log.info("build.check", {
    files: paths.length,
    reused: paths.length - due.length,
    parts,
  });
  return checkedDiagnostics(paths, records);
};

/**
 * The build the compiler answered (`Unchecked`), with its type check put
 * in: run in the type checker's isolate (the compiler's `checker.ts`),
 * once the compiler has answered, never inside its call, a part at a time
 * (`typeChecked`), and put together with the build as the build would
 * have (`withTypeCheck`). A build that waits on no check (one that failed
 * before it) is as it came. The build's lease is renewed as each check
 * call starts: each is a call of its own, on-prem with its own wait for a
 * place.
 */
const withItsCheck = async (
  runner: PlatformRunner,
  answer: unknown,
  lease: BuildLease
): Promise<unknown> => {
  if (
    typeof answer !== "object" ||
    answer === null ||
    !("built" in answer) ||
    !isBuildShaped(answer.built)
  ) {
    throw new TypeError("The compiler answered something else than a build.");
  }
  // SAFETY: shaped as a build, checked above; its plan is the compiler's
  // own, which core trusts as it trusts the build.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const unchecked = answer as Unchecked<{ ok: boolean }>;
  if (unchecked.typeCheck === undefined) {
    return unchecked.built;
  }
  return withTypeCheck(
    unchecked,
    await typeChecked(runner, unchecked.typeCheck, lease)
  );
};

/**
 * A build of `files` by the compiler, wherever the runner runs it, and
 * whether to cache it: the compiler's answer, or a failed build when it
 * was stopped at a bound (a type built to recurse, say). A stop the files
 * reach whatever the load (CPU time, memory, an answer too large) is
 * cached as the failed build it is, so an App whose page holds the
 * checker can't make the compiler run on every view, on Cloudflare or
 * on-prem. A stop the load can cause (the wall-clock deadline, a process
 * killed) isn't: the next view builds again.
 *
 * Code the host generated (a JSON workflow's module) is never stopped by
 * its author: the generator, not a builder, writes its types, so no stop
 * is a verdict on it. Any stop of its build is thrown as it is, never a
 * failed build and never cached, for its publication to be tried again
 * (`workflow.build_slow`, workflow-builds.ts).
 */
const compiled = async (
  runner: PlatformRunner,
  kind: BuildKind,
  files: AppFiles,
  profile: BuildProfile,
  /** The build's lease, renewed as each type check call starts. */
  lease: BuildLease,
  /** The compiler call, when not the kind's own: what it answers as the build. */
  call: () => Promise<unknown> = async () => {
    const [method, target] = compilerCallOf(kind, profile);
    const answer = await runner.run("compiler", method, [target, files]);
    // Inspection checks no types: its build is as it came.
    return method === "build"
      ? await withItsCheck(runner, answer, lease)
      : answer;
  }
): Promise<{ built: unknown; cache: boolean }> => {
  try {
    return { built: await call(), cache: true };
  } catch (error) {
    // A JSON workflow's generated module is never its author's to fix,
    // and a stop of compute modules that the load made (a deadline, a
    // crash) isn't either: both are thrown on, for the caller to answer
    // as a build to try again (`workflow.build_slow`).
    if (
      !(error instanceof PlatformBoundError) ||
      kind === "generated-workflow" ||
      (kind === "compute" && !error.own)
    ) {
      throw error;
    }
    const failed: FailedBuild = {
      ok: false,
      diagnostics: [
        {
          rule: "compile",
          severity: "error",
          message: `The compiler was stopped before it finished: ${error.message} Simplify the ${kind === "compute" ? "modules'" : "App's"} types (a type that recurses without end holds the type checker).`,
        },
      ],
    };
    return { built: failed, cache: error.own };
  }
};

/** Whether `value` is what the compiler's `buildIncrementally` answers, its build aside. */
const incrementalShaped = (
  value: unknown
): value is IncrementalBuild<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "built" in value &&
  "fresh" in value &&
  typeof value.fresh === "object" &&
  value.fresh !== null &&
  "metrics" in value &&
  typeof value.metrics === "object" &&
  value.metrics !== null;

/**
 * The CPU time, in ms, Babel with the React Compiler takes for one
 * character of page source on Cloudflare, at most: measured on a laptop
 * (2026-11-04) at 5–9 µs (a 60-page App's 820,000 characters in 4.2–6.9
 * s), and Cloudflare runs 2–5× slower than a laptop.
 */
const transformCpuMsPerCharacter = 0.045;

/**
 * The CPU time on Cloudflare a batch of transforms is sized to: a few
 * seconds, so a first build answers in steps and a stop costs little, far
 * below a call's ceiling (`compilerTaskCpuMs`, 60 s), which only stops
 * failures and leaves room for a cold isolate's start (loading Babel, the
 * React Compiler and the kit) and a machine slower than measured.
 */
const batchCpuMs = 4000;

/**
 * The most characters of source one batch of transforms takes
 * (`transformInBatches`): about 89,000 (`batchCpuMs`), or fewer where
 * tests size batches to less CPU time (`BUILD_BATCH_CPU_MS`). One file
 * larger than that (up to the 200,000 a file may have) is a batch of its
 * own, still well within a call's CPU time.
 */
const batchCharacters = (env: BuildEnv): number => {
  const set = Number(env.BUILD_BATCH_CPU_MS);
  const cpuMs =
    Number.isInteger(set) && set > 0 && set < batchCpuMs ? set : batchCpuMs;
  return Math.floor(cpuMs / transformCpuMsPerCharacter);
};

/**
 * Transforms what a pages build of `files` (`target`) would and `reuse`
 * lacks, a batch at a time, before the build: the whole of a large App's
 * first build (after a release, every App's) is many times one call's CPU
 * time, and the runtime stops a call past it. Each batch is one compiler
 * call, handed only its own sources, sized well within a call's CPU time
 * (`batchCharacters`); what each made is kept at once (module-cache.ts),
 * so a build stopped part way resumes where it stopped. A batch stopped at
 * a bound is split and each half tried again; one file stopped alone is
 * left to the build, which says why. Nothing when all that's missing fits
 * in one batch, the build transforms it itself; nor when the build is
 * refused before anything compiles (`pageRefusals`). The build's lease is
 * renewed as each batch starts (`renew`). What the batches made, by key,
 * for the build to reuse, and how many calls they took.
 */
const transformInBatches = async (
  env: BuildEnv,
  runner: PlatformRunner,
  {
    files,
    target,
    keys,
    reuse,
    leaseMs,
    renew,
  }: {
    files: AppFiles;
    target: string;
    keys: IncrementKeys;
    reuse: Increments;
    leaseMs: number;
    renew: () => Promise<void>;
  }
): Promise<{ made: Increments["modules"]; calls: number }> => {
  const made: Increments["modules"] = {};
  let calls = 0;
  const app = buildFiles(files);
  // Refused in milliseconds by the build itself: no batch is spent first.
  if (pageRefusals(app).length > 0) {
    return { made, calls };
  }
  const { sources, known, typeFiles } = pageSources(app);
  const missing = sources.filter(
    ([path]) => !Object.hasOwn(reuse.modules, keys.modules[path] ?? "")
  );
  const characters = batchCharacters(env);
  if (
    missing.reduce((sum, [, source]) => sum + source.length, 0) <= characters
  ) {
    return { made, calls };
  }
  const pathOf = new Map(
    Object.entries(keys.modules).map(([path, key]) => [key, path])
  );
  const transform = async (batch: Record<string, string>): Promise<void> => {
    // The build holds its lease while its batches run, each a lease's
    // time from its start: one that died gives it up as one call would.
    await renew();
    calls += 1;
    // Once: a stop splits the batch (`callSplitting`), which is its retry,
    // and nothing of a stopped batch is kept as failed.
    const answer: unknown = await runner.run(
      "compiler",
      "transform",
      [target, batch, { known, typeFiles }],
      { once: true }
    );
    const fresh: Increments = { modules: {} };
    for (const [key, value] of Object.entries(
      typeof answer === "object" && answer !== null ? answer : {}
    )) {
      const record = moduleRecordOf(value, pathOf.get(key) ?? "");
      if (record !== undefined) {
        fresh.modules[key] = record;
      }
    }
    await keepIncrements(env, keys, fresh, leaseMs);
    Object.assign(made, fresh.modules);
  };
  for (const batch of batchesOf(missing, { characters })) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one call at a time, each within its CPU time
      await callSplitting(batch, transform);
    } catch (error) {
      // The load's stop (a deadline, a crash), which `callSplitting` never
      // splits: what is left goes to the build, as a file stopped alone does.
      if (error instanceof PlatformBoundError) {
        break;
      }
      throw error;
    }
  }
  return { made, calls };
};

/**
 * A pages build of `files` (spec 19.2, GRA-958), reusing what earlier
 * builds kept of each file (module-cache.ts): the compiler checks each
 * against the key it works out itself, and redoes the rest with every
 * gate; what it made now is kept for the next. A first build of a large
 * App transforms its files in batches first (`transformInBatches`). Its
 * metrics: putting it together from what was kept, the batches, the
 * compiler's run, and how much of each part was done now or reused.
 */
const compiledIncrementally = async (
  runner: PlatformRunner,
  files: AppFiles,
  { profile, checks }: { profile: BuildProfile; checks: boolean },
  /** Its lease, renewed as each batch starts, before the build's own call, and before each check call. */
  lease: BuildLease
): Promise<{ built: unknown; cache: boolean }> => {
  const { env, leaseMs, renew } = lease;
  const preview = profile === "preview";
  const [, target] = compilerCallOf("page", profile, checks);
  const started = Date.now();
  // Hashed once: every read and write of its records uses them.
  const keys = await pageIncrementKeys(files, preview);
  const earlier = await readIncrements(env, keys, buildRefreshMs);
  const read = Date.now();
  const batched = await transformInBatches(env, runner, {
    files,
    target,
    keys,
    reuse: earlier,
    leaseMs,
    renew,
  });
  const reuse: Increments = {
    modules: { ...earlier.modules, ...batched.made },
  };
  if (batched.calls > 0) {
    // A lease's time for the build's own call, after its batches.
    await renew();
  }
  const transformed = Date.now();
  let answer: unknown;
  const result = await compiled(
    runner,
    "page",
    files,
    profile,
    lease,
    async () => {
      answer = await runner.run("compiler", "buildIncrementally", [
        target,
        files,
        reuse,
      ]);
      if (!incrementalShaped(answer)) {
        throw new TypeError(
          "The compiler answered something else than an incremental build."
        );
      }
      return await withItsCheck(runner, answer.built, lease);
    }
  );
  const ran = Date.now();
  const kept = incrementalShaped(answer)
    ? await keepIncrements(env, keys, answer.fresh, leaseMs)
    : 0;
  log.info("build.compile", {
    kind: "page",
    profile,
    // Putting the build together: what was kept read, and kept now.
    assemblyMs: read - started + (Date.now() - ran),
    // The batches' transforms, their calls, and the modules they made.
    batchMs: transformed - read,
    batchCalls: batched.calls,
    batched: Object.keys(batched.made).length,
    // The compiler's run: transforms, checks and the CSS.
    executionMs: ran - transformed,
    ...(incrementalShaped(answer)
      ? (answer.metrics satisfies BuildMetrics)
      : {}),
    kept,
  });
  return result;
};

/** Where the builds' sweep left off: which kind, and R2's cursor in it. */
const buildSweepKey = "builds-sweep.json";

/** The most objects one run of the builds' sweep reads. */
const buildSweepBatch = 500;

/** The prefix inspected manifests are cached under (app-inspection.ts). */
export const inspectionsPrefix = "inspections/";

/** The prefix a JSON workflow's expression checks are cached under (`checkWorkflowExpressions`). */
const expressionChecksPrefix = "expression-checks/";

/**
 * The prefix each kind of build is cached under, inspected manifests, what
 * pages builds keep of each file (module-cache.ts), and the bad bytes
 * kept for operators (build-cache.ts), which all go after the same time.
 */
const buildPrefixes = [
  ...Object.keys(compilerCalls).map((kind) => `${kind}-builds/`),
  inspectionsPrefix,
  ...Object.values(incrementPrefixes),
  "build-quarantine/",
  // Each file's type check, which pages builds kept until the check
  // moved to an isolate of its own (GRA-1562): nothing writes it now, so
  // the sweep empties it within `buildKeepMs` of the release that stopped
  // writing it. Remove once every deployment has run that release for 30
  // days (expand, then contract).
  "screen-checks/",
  // A sweep's state is the index of the prefix it is in: a new prefix
  // goes last, so no sweep part way through one resumes in another.
  expressionChecksPrefix,
  // The generated module's builds, under the build kind's name before it
  // was `generated-workflow`: nothing writes it now. Remove with
  // `screen-checks/`, for the same reason.
  "open-workflow-builds/",
  // Pages' builds and the modules they keep, under their names before
  // screens were pages (GRA-1532): nothing writes them now. Remove with
  // `screen-checks/`, for the same reason.
  "screen-builds/",
  "screen-modules/",
  checksPrefix,
];

const buildSweepSchema = z.object({
  prefix: z
    .int()
    .min(0)
    .max(buildPrefixes.length - 1),
  cursor: z.string().optional(),
});

/**
 * Deletes cached builds last used more than `buildKeepMs` before `now`,
 * from the clock: in code, not a bucket rule, so it runs wherever core
 * does. One page of one kind's prefix a run, at most `buildSweepBatch`
 * objects, from where the last run stopped; once a kind is done, the next
 * run starts the next. A build is never last used after it was uploaded,
 * so only those uploaded that long ago are read again, just before they
 * go: one used since the listing is kept. R2 deletes take no condition,
 * so one used between that read and the delete is still lost, and built
 * again the next time it is asked for.
 */
export const sweepBuilds = async (env: Env, now: Date): Promise<void> => {
  const stored = await env.FILES.get(buildSweepKey);
  const parsed = buildSweepSchema.safeParse(
    stored === null ? undefined : await stored.json()
  );
  const state = parsed.success ? parsed.data : { prefix: 0 };
  const prefix = buildPrefixes[state.prefix] ?? "page-builds/";
  const listed = await env.FILES.list({
    prefix,
    limit: buildSweepBatch,
    ...(state.cursor === undefined ? {} : { cursor: state.cursor }),
  });
  const unused = (object: R2Object): boolean =>
    now.getTime() - lastUsedOf(object) > buildKeepMs;
  const candidates = listed.objects.filter(
    ({ uploaded }) => now.getTime() - uploaded.getTime() > buildKeepMs
  );
  const stillUnused = await Promise.all(
    candidates.map(async ({ key }) => {
      const head = await env.FILES.head(key);
      return head !== null && unused(head) ? [key] : [];
    })
  );
  const keys = stillUnused.flat();
  if (keys.length > 0) {
    await env.FILES.delete(keys);
    await forgetReceipts(env, keys);
  }
  const next = listed.truncated
    ? { prefix: state.prefix, cursor: listed.cursor }
    : { prefix: (state.prefix + 1) % buildPrefixes.length };
  await env.FILES.put(buildSweepKey, JSON.stringify(next));
  await sweepReceipts(env, now);
};

/**
 * `cacheKey`'s answer through the verified cache (build-cache.ts): kept
 * with when it was last used, and a hit older than `buildRefreshMs`
 * written again, so one in use never reaches the sweep's limit
 * (`sweepBuilds`). Builds and inspected manifests are kept alike.
 */
export const throughKeptCache = async (
  env: CacheEnv,
  cacheKey: string,
  leaseMs: number,
  build: (renew: () => Promise<void>) => Promise<Built>,
  signal?: AbortSignal
): Promise<CachedAnswer> => {
  const answer = await throughCache(
    env,
    cacheKey,
    leaseMs,
    build,
    usedNow,
    signal
  );
  const { text, object, objectKey } = answer;
  if (
    object !== undefined &&
    objectKey !== undefined &&
    Date.now() - lastUsedOf(object) > buildRefreshMs
  ) {
    try {
      // The same bytes, while its receipt still names them.
      await refreshKept(env, cacheKey, objectKey, text, usedNow());
    } catch (error) {
      // Served all the same: a refresh that failed is tried again at its
      // next use, well before the sweep's limit.
      log.warn("build.refresh_failed", errorFields(error));
    }
  }
  return answer;
};

/**
 * The builds running now in this isolate, by whose build and its cache
 * key: a build
 * asked for while the same one runs waits for it rather than start the
 * compiler again, so views of one App's page take one place in the
 * sandbox, not one each. A build whose request was cancelled never
 * settles, so it is waited for only as long as a build may take
 * (`sharedRun`).
 */
const buildsRunning = new Map<string, SharedRun<CachedAnswer>>();

/** What a build through the cache answered, as the requests sharing it get it. */
type CachedAnswer = Awaited<ReturnType<typeof throughCache>>;

/**
 * A shared build's starter gave up on it before it compiled: those who
 * shared it, still waiting, start their own.
 */
class StarterGaveUpError extends Error {
  override name = "StarterGaveUpError";
}

/**
 * `key`'s build through the cache, shared by every request of this
 * isolate that asks for it while it runs: the lease holder's answer,
 * cacheable or not (a quarantined key, a stop the load caused), goes to
 * them all, so concurrent views of one page compile once. A request
 * given up on stops; one that shared another's build that was given up on
 * before it compiled starts its own.
 */
const sharedThroughCache = async (
  key: string,
  abandonAfterMs: number,
  run: (signal?: AbortSignal) => Promise<CachedAnswer>,
  signal?: AbortSignal
): Promise<CachedAnswer> => {
  for (let tries = 0; ; tries += 1) {
    signal?.throwIfAborted();
    try {
      // oxlint-disable-next-line no-await-in-loop -- once more only if its starter gave up
      return await sharedRun(
        buildsRunning,
        key,
        abandonAfterMs,
        async () => {
          try {
            return await run(signal);
          } catch (error) {
            if (signal?.aborted === true) {
              throw new StarterGaveUpError("Its starter gave up on the build", {
                cause: error,
              });
            }
            throw error;
          }
        },
        signal
      );
    } catch (error) {
      if (!(error instanceof StarterGaveUpError)) {
        throw error;
      }
      // Ours given up on: why it was.
      if (signal?.aborted === true) {
        throw error.cause;
      }
      if (tries >= 2) {
        throw error;
      }
    }
  }
};

/**
 * A build of the files `select` picks, the only ones it reads: limited
 * first, so the limits bound the hashing and sending too. From R2 (in the
 * EU), or built by the compiler and stored there. A failed build is
 * cached too, where the files alone failed it (`compiled`): the same
 * files fail the same way with the same compiler, so an App that doesn't
 * build can't start the compiler on every request. A build that throws
 * isn't cached. A cached build is served only as its trusted receipt
 * says it was built, and builds of the same files run once in any
 * isolate, under the key's lease (build-cache.ts); two requests in one
 * isolate also share one compile (`buildsRunning`). A cached build is kept `buildKeepMs` past
 * its last use (`sweepBuilds`): one read older than `buildRefreshMs` is
 * written again, so a build in use is never as old as the sweep's limit.
 */
const cachedBuild = async <Build>(
  env: BuildEnv,
  kind: BuildKind,
  appFiles: AppFiles,
  select: (files: AppFiles) => AppFiles,
  /** Whose build it is: the App's, or an independent workflow's, ID. */
  whose: string,
  { profile = "production", signal, checks = true }: BuildOptions = {}
): Promise<Build | FailedBuild> => {
  const files = select(appFiles);
  const tooMuch = limitsOf(kind)(files);
  if (tooMuch.length > 0) {
    return { ok: false, diagnostics: tooMuch };
  }
  // The compiler parses, transforms and type-checks App source, and
  // TypeScript's checker alone can be held for good by a type built to
  // recurse, whatever the source's size: it runs only where it is bounded
  // (platform-sandbox.ts). Where nothing bounds it, refused before the
  // cache is read: a deployment where nothing compiles has nothing cached
  // to serve.
  const runner = platformRunner(env, whose);
  // Under the call the build is, as well as its kind: a change to which
  // compiler call a kind makes (`compilerCalls`) builds again, rather than
  // serving what the old call built for as long as it is kept. Under its
  // profile too: a preview's build is never served as production's.
  const [callMethod, callTarget] = compilerCallOf(kind, profile, checks);
  const cacheKey = `${kind}-builds/${callMethod}.${callTarget}/${keySchema}/${profile}/${await buildKey(files)}.json`;
  const isBuild = (value: unknown): value is Build | FailedBuild =>
    isBuildShaped(value);
  const started = Date.now();
  // Renewed as each call starts (`renew`): long enough for the longest,
  // the compiler's or the type checker's.
  const leaseMs =
    Math.max(runner.callMs("compiler"), runner.callMs("type-checker")) +
    leaseSlackMs;
  const { text, outcome } = await sharedThroughCache(
    // One sub-owner's: another App building the same files builds them in
    // its own part of the builder's share, never on this one's (or with
    // its refusal). The cache itself is by content alone.
    `${whose}\n${cacheKey}`,
    // Waited on as long as a lease, and the wait for one, may take.
    leaseMs * 2,
    async (given) =>
      await throughKeptCache(
        env,
        cacheKey,
        // Held as long as a build may take, and a little more.
        leaseMs,
        async (renew) => {
          const lease = { env, whose, leaseMs, renew };
          const answer =
            kind === "page"
              ? await compiledIncrementally(
                  runner,
                  files,
                  { profile, checks },
                  lease
                )
              : await compiled(runner, kind, files, profile, lease);
          if (!isBuild(answer.built)) {
            throw new TypeError(
              "The compiler answered something else than a build."
            );
          }
          return { text: JSON.stringify(answer.built), cache: answer.cache };
        },
        given
      ),
    signal
  );
  // Assembly, transforms and execution are the compiler's own; this is
  // the cache's part: how a build came about, and how long it took.
  log.info("build.cache", {
    kind,
    profile,
    outcome,
    ms: Date.now() - started,
  });
  const built: unknown = JSON.parse(text);
  if (!isBuild(built)) {
    throw new TypeError("The compiler answered something else than a build.");
  }
  return built;
};

/**
 * Builds an App's pages into ES modules and their CSS, in the compiler's
 * isolate. The modules import the release's kit modules (`kitModules(env.ASSETS)`);
 * `pages` in the result names the ones each page needs. A build is
 * cached in R2.
 */
export const buildPages = async (
  env: BuildEnv,
  appFiles: AppFiles,
  /** Whose build it is: the App's ID. */
  whose: string,
  options?: BuildOptions
): Promise<PageBuild> =>
  await cachedBuild<PageBuild>(
    env,
    "page",
    appFiles,
    buildFiles,
    whose,
    options
  );

/**
 * Builds an App's server code of spec 8's layout (its schema, values,
 * registration and operations, with the modules the host generated for it
 * under `.grasp/`) into ES modules, in the compiler's isolate, each file
 * held to what its kind may import. Cached in R2 like the others: the
 * generated modules are among the files the key hashes.
 */
export const buildAppCode = async (
  env: BuildEnv,
  appFiles: AppFiles,
  /** Whose build it is: the App's ID. */
  whose: string,
  options?: BuildOptions
): Promise<AppCodeBuild> =>
  await cachedBuild<AppCodeBuild>(
    env,
    "app",
    appFiles,
    appCodeFiles,
    whose,
    options
  );

/**
 * An App's server code with its tests: what `checkAppCode` reads, and
 * with `buildAppCode`'s (a part of it) all a seal compiles and inspects.
 */
export const appCodeAndTestFiles = (files: AppFiles): AppFiles => ({
  ...appTestFiles(files),
  ...appCodeFiles(files),
});

/**
 * Builds an App's server code of spec 8's layout as `buildAppCode` does,
 * then type-checks it against the SDK's server side, with the host's
 * generated modules among its files and no DOM (the compiler's
 * `checkAppCode`): its modules, or why it fails, type errors included.
 * What a seal holds a release to. Cached in R2 like the others.
 */
export const checkAppCode = async (
  env: BuildEnv,
  appFiles: AppFiles,
  /** Whose build it is: the App's ID. */
  whose: string,
  options?: BuildOptions
): Promise<AppCodeBuild> =>
  await cachedBuild<AppCodeBuild>(
    env,
    "app-check",
    appFiles,
    appCodeAndTestFiles,
    whose,
    options
  );

/**
 * Builds an App's tests (`tests/**.ts`) into ES modules, in the
 * compiler's isolate, each held to what a test may import. Only the test
 * files become modules: what they import of the App comes from its
 * release (app-tests.ts). Cached in R2 like the others.
 */
export const buildAppTests = async (
  env: BuildEnv,
  appFiles: AppFiles,
  /** Whose build it is: the App's ID. */
  whose: string
): Promise<AppCodeBuild> =>
  await cachedBuild<AppCodeBuild>(
    env,
    "app-tests",
    appFiles,
    appTestFiles,
    whose
  );

/**
 * Builds the module the host generated from a JSON workflow
 * (`.grasp/workflow.ts`, workflow-builds.ts) into one ES module, in the
 * compiler's isolate, type-checked against its SDK. Cached in R2 like the
 * others: the same generated module builds the same with the same
 * compiler, so identical definitions share one build.
 */
export const buildGeneratedWorkflow = async (
  env: BuildEnv,
  files: AppFiles,
  /** Whose build it is: the independent workflow's ID. */
  whose: string
): Promise<GeneratedWorkflowBuild> =>
  await cachedBuild<GeneratedWorkflowBuild>(
    env,
    "generated-workflow",
    files,
    (all) => all,
    whose
  );

/**
 * Type-checks a JSON workflow's expressions against the types of what
 * they read (`scope`, which core writes from the workflow's schemas): one
 * run of the type checker's isolate (the compiler's `expressionTypeCheck`
 * builds it and reads its diagnostics), none when every expression failed
 * the subset already. Its diagnostics are cached in R2 like a build, by
 * the module checked: the same expressions in the same scope check the
 * same with the same release, so a draft's edit that changes none of them
 * checks nothing again.
 */
export const checkWorkflowExpressions = async (
  env: BuildEnv,
  scope: ExpressionScopeTypes,
  expressions: Record<string, TypedExpression>,
  /** Whose check it is: the independent workflow's ID. */
  whose: string
): Promise<ExpressionTypeCheck> => {
  const { request, checked } = expressionTypeCheck(scope, expressions);
  if (request === undefined) {
    return checked([]);
  }
  const runner = platformRunner(env, whose);
  // The whole request, its compiler options too, which are core's
  // (expression-types.ts lives in core's bundle, not the compiler's).
  const cacheKey = `${expressionChecksPrefix}${keySchema}/${compilerVersion}/${await sha256Hex(canonicalText(request))}.json`;
  const leaseMs = runner.callMs("type-checker") + leaseSlackMs;
  const { text } = await sharedThroughCache(
    `${whose}\n${cacheKey}`,
    leaseMs * 2,
    async (given) =>
      await throughKeptCache(
        env,
        cacheKey,
        leaseMs,
        async () => {
          const diagnostics = await runner.run("type-checker", "check", [
            request,
          ]);
          if (!Array.isArray(diagnostics)) {
            throw new TypeError(
              "The type checker answered something else than diagnostics."
            );
          }
          // A check that couldn't run (tsrs failed, its answer unread) is
          // no verdict on the expressions: thrown, never cached, for the
          // publication to be tried again (workflow-resources.ts).
          const stop: unknown = diagnostics.find(
            (diagnostic: unknown) =>
              typeof diagnostic === "object" &&
              diagnostic !== null &&
              "rule" in diagnostic &&
              diagnostic.rule === "check"
          );
          if (stop !== undefined) {
            throw new Error(
              "The type checker couldn't check the expressions.",
              {
                cause: stop,
              }
            );
          }
          return { text: JSON.stringify(diagnostics), cache: true };
        },
        given
      )
  );
  // SAFETY: the checker's answer, as core stored it under its receipt.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return checked(JSON.parse(text) as Diagnostic[]);
};

/**
 * Builds a JSON workflow's compute modules (`code/<file>.ts`,
 * workflow-modules.ts) into ES modules, in the compiler's isolate,
 * type-checked against `@grasp-os/sdk/compute`. Cached in R2 like the
 * others.
 */
export const buildComputeModules = async (
  env: BuildEnv,
  files: AppFiles,
  /** Whose build it is: the independent workflow's ID. */
  whose: string
): Promise<ComputeModulesBuild> =>
  await cachedBuild<ComputeModulesBuild>(
    env,
    "compute",
    files,
    (all) => all,
    whose
  );

/** The details of a `*.build_failed` error: the version (null for a draft), and why. */
export const buildFailed = (
  version: number | null,
  { diagnostics }: FailedBuild
): NonNullable<ErrorPayload["details"]> => ({
  version,
  diagnostics: diagnostics.map(({ file, line, rule, message }) => ({
    file: file ?? null,
    line: line ?? null,
    category: diagnosticCategory(rule),
    message,
  })),
});

/** A page as core built it: its name, its code, and the hash of that code. */
/** An App's pages, built: what a frame runs. */
export interface BuiltPage {
  code: FrameCode;
  /** `code`'s hash under its profile (`pageArtifact`): what an admin approves. */
  artifact: string;
}

/** An App's pages as a build makes them: their code, and the surfaces they declare. */
export interface PageBuildResult extends BuiltPage {
  surfaces: SurfaceManifest[];
}

/**
 * These of `modules`, by name. A build names only modules it has or the
 * kit has, so one that is missing means the build and the kit are not of
 * one release: that fails here, not as an import the frame can't resolve.
 */
const pick = (
  modules: Record<string, string>,
  names: string[]
): Record<string, string> =>
  Object.fromEntries(
    names.map((name) => {
      const code = modules[name];
      if (code === undefined) {
        throw new Error(`The page's build names ${name}, which is missing.`);
      }
      return [name, code];
    })
  );

/**
 * The hash of a page's code built for `profile`: what an admin
 * approves, and what its frame is staged under. The profile is part of
 * it, so a preview's artifact never passes for production's.
 */
export const pageArtifact = async (
  profile: BuildProfile,
  { entry, runtime, modules, addresses, kit, css }: FrameCode
): Promise<string> =>
  await sha256Hex(
    canonicalJson({
      profile,
      code: { entry, runtime, modules, addresses, kit, css },
    })
  );

/**
 * Builds the pages of an App's `files` (at `version`; null for a chat's
 * draft), within the build wait, the kit's modules too: whoever asked
 * hears `page.build_slow` rather than wait on a build that doesn't
 * answer, and `page.build_failed` when it doesn't build. They build
 * together, one single page app from their route tree, with what it
 * loads and nothing else: the App's and the kit's modules the routes
 * reach. Files with no page build nothing (the compiler would refuse
 * them): `page.not_found`.
 */
export const versionPages = async (
  env: Env,
  files: Record<string, string>,
  version: number | null,
  /** Whose pages they are: the App's ID. */
  app: string,
  /** `preview` for a chat's draft. */
  profile: BuildProfile,
  { checks = true }: Pick<BuildOptions, "checks"> = {}
): Promise<PageBuildResult> => {
  if (!Object.keys(files).some((path) => isPageFile(path))) {
    throw pageErrors.create("page.not_found");
  }
  const loaded = await withinBuildWait(
    env,
    async () =>
      await Promise.all([
        buildPages(env, files, app, { profile, checks }),
        // A preview runs on the preview kit (spec 19.2.1), which its
        // build's closures name.
        profile === "preview"
          ? kitPreviewModules(env.ASSETS)
          : kitModules(env.ASSETS),
      ])
  );
  if (loaded === "late") {
    throw pageErrors.create("page.build_slow");
  }
  const [build, { modules: kit }] = loaded;
  if (!build.ok) {
    throw pageErrors.create("page.build_failed", buildFailed(version, build));
  }
  const { entry, closure } = build;
  const code = {
    entry,
    runtime: kitModuleName(
      profile === "preview" ? previewRuntime : pageRuntime
    ),
    modules: pick(build.modules, closure.modules),
    addresses: pick(build.addresses, closure.modules),
    kit: pick(kit, closure.kitModules),
    css: build.css,
  };
  // Which code a frame runs, in core's words: what an admin approves,
  // what the frame's document runs and nothing else (page-frame.ts),
  // and what the page expects the frame to say back once the pages have
  // mounted (page-host.ts).
  return {
    code,
    artifact: await pageArtifact(profile, code),
    surfaces: build.surfaces,
  };
};
