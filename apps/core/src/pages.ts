import {
  appCodeFiles,
  appCodeLimitErrors,
  appTestFiles,
  isPageFile,
  buildFiles,
  kitModuleName,
  kitModules,
  kitPreviewModules,
  previewRuntime,
  pageRuntime,
  limitErrors,
  computeModuleErrors,
  computePackagesFile,
  packageModulesFile,
  expressionTypeCheck,
  generatedWorkflowErrors,
  pageIncrementKeys,
  withTypeCheck,
} from "@grasp-os/compiler";
import type {
  PackageTarget,
  AppCodeBuild,
  BuildMetrics,
  CompileTarget,
  Diagnostic,
  InspectTarget,
  ComputeModulesBuild,
  ExpressionScopeTypes,
  ExpressionTypeCheck,
  IncrementalBuild,
  GeneratedWorkflowBuild,
  TypedExpression,
  PageBuild,
  SurfaceManifest,
  Unchecked,
} from "@grasp-os/compiler";
import { diagnosticCategory } from "@grasp-os/shared/diagnostics";
import { sha256Hex } from "@grasp-os/shared/encoding";
import type { ErrorPayload } from "@grasp-os/shared/errors";
import { canonicalJson } from "@grasp-os/shared/json";
import { log } from "@grasp-os/shared/log";
import { pageErrors } from "@grasp-os/shared/pages";
import { sharedRun } from "@grasp-os/shared/shared-runs";
import type { SharedRun } from "@grasp-os/shared/shared-runs";
import { z } from "zod";

import {
  buildCachePrefix,
  cacheKeyOf,
  inOrder,
  keepModules,
  readModules,
  throughCache,
} from "./build-cache.ts";
import type { CacheEnv, CacheOutcome } from "./build-cache.ts";
import { appPackageModules } from "./packages/build.ts";
import type { PackageBuildEnv } from "./packages/build.ts";
import type { FrameCode } from "./page-frame.ts";
import { PlatformBoundError, platformRunner } from "./platform-sandbox.ts";
import type { PlatformRunner } from "./platform-sandbox.ts";
import { sessionHost } from "./sandboxed.ts";

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

/** An App's files at one version, by path. */
type AppFiles = Record<string, string>;

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

/**
 * What building reads from core's env: the sandbox, the cache (in R2, in
 * the EU), and what bundles an App's approved packages (packages/build.ts).
 */
export type BuildEnv = PackageBuildEnv;

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
  /**
   * False for what a preview's frame and a draft's write build: pages
   * without the type check (the compiler's `preview-frame`), which runs
   * as an agent's turn would answer, and at publish (agent-builds.ts).
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

/**
 * The build the compiler answered (`Unchecked`), with its type check put
 * in: run in the type checker's isolate (the compiler's `checker.ts`),
 * once the compiler has answered, never inside its call, and put
 * together with the build as the build would have (`withTypeCheck`). A
 * build that waits on no check (one that failed before it) is as it came.
 */
const withItsCheck = async (
  runner: PlatformRunner,
  answer: unknown
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
  const diagnostics = await runner.run("type-checker", "check", [
    unchecked.typeCheck.request,
  ]);
  if (!Array.isArray(diagnostics)) {
    throw new TypeError(
      "The type checker answered something else than diagnostics."
    );
  }
  // SAFETY: the checker's answer, core's own code, checked an array.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return withTypeCheck(unchecked, diagnostics as Diagnostic[]);
};

/**
 * A build of `files` by the compiler, wherever the runner runs it, and
 * whether to cache it: the compiler's answer, or a failed build when it
 * was stopped at a bound (CPU time, memory, a deadline). A stop is never
 * cached: it says the limit was reached this time, not that these files
 * fail, so the next build tries again rather than serve the stop until the
 * files change.
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
  /** The compiler call, when not the kind's own: what it answers as the build. */
  call: () => Promise<unknown> = async () => {
    const [method, target] = compilerCallOf(kind, profile);
    const answer = await runner.run("compiler", method, [target, files]);
    // Inspection checks no types: its build is as it came.
    return method === "build" ? await withItsCheck(runner, answer) : answer;
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
          message: `The compiler was stopped before it finished: ${error.message} It tries again at the next build; should it stop again, simplify the ${kind === "compute" ? "modules'" : "App's"} types (a type that recurses without end holds the type checker).`,
        },
      ],
    };
    return { built: failed, cache: false };
  }
};

const day = 24 * 60 * 60 * 1000;

/**
 * How long a cache entry is kept after it was last written: the clock's sweep
 * deletes what is older (`sweepBuilds`). An entry is the toolchain's
 * output for files core keeps, under its version, so one swept is made
 * again, the same, the next time it is asked for: what runs never rests
 * on the cache. A release misses every entry of the one before, which go
 * once their time is up.
 */
export const buildKeepMs = 30 * day;

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
 * A pages build of `files` (spec 19.2, GRA-958), as Vite's dev server
 * compiles a module the first time it is asked for and serves it from
 * its cache after: it reuses each module's transform earlier builds kept
 * (build-cache.ts), which the compiler checks against the key it works
 * out itself, and transforms the rest in the same call, with every gate;
 * what it made now is kept for the next. A first build after a release
 * transforms the whole App in one call: an App at its limits (a million
 * characters) takes 4.6–9.5 s and 64–72 MB of heap on a laptop (GRA-1633),
 * well within the call's CPU time (`compilerTaskCpuMs`, 60 s) and the
 * isolate's 128 MB. Its metrics: putting it together from what was kept,
 * the compiler's run, and how many modules were done now or reused.
 */
const compiledIncrementally = async (
  env: BuildEnv,
  runner: PlatformRunner,
  files: AppFiles,
  { profile, checks }: { profile: BuildProfile; checks: boolean }
): Promise<{ built: unknown; cache: boolean }> => {
  const [, target] = compilerCallOf("page", profile, checks);
  const started = Date.now();
  // Hashed once: every read and write of its modules uses them.
  const keys = await pageIncrementKeys(files, profile === "preview");
  const reuse = await readModules(env, keys);
  const read = Date.now();
  let answer: unknown;
  const result = await compiled(runner, "page", files, profile, async () => {
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
    return await withItsCheck(runner, answer.built);
  });
  const ran = Date.now();
  const kept = incrementalShaped(answer)
    ? await keepModules(env, keys, answer.fresh)
    : 0;
  log.info("build.compile", {
    kind: "page",
    profile,
    // Putting the build together: what was kept read, and kept now.
    assemblyMs: read - started + (Date.now() - ran),
    // The compiler's run: transforms, checks and the CSS.
    executionMs: ran - read,
    ...(incrementalShaped(answer)
      ? (answer.metrics satisfies BuildMetrics)
      : {}),
    kept,
  });
  return result;
};

/** Where the cache's sweep left off: R2's cursor. */
const buildSweepKey = "build-cache-sweep.json";

/** The most entries one run of the sweep reads. */
const buildSweepBatch = 500;

/** Where the sweep left off in the cache: only ever under its prefix. */
const buildSweepSchema = z.strictObject({
  prefix: z.literal(buildCachePrefix),
  cursor: z.string().optional(),
});

/**
 * Deletes cache entries written more than `buildKeepMs` before `now`,
 * from the clock: in code, not a bucket rule, so it runs wherever core
 * does. An entry in use is written again as it is read, once a week at
 * most (build-cache.ts), so only those nothing read go. One page of the
 * cache a run, at most `buildSweepBatch` entries, from where the last run
 * stopped.
 */
export const sweepBuilds = async (env: Env, now: Date): Promise<void> => {
  const stored = await env.FILES.get(buildSweepKey);
  const parsed = buildSweepSchema.safeParse(
    stored === null ? undefined : await stored.json()
  );
  // A state of another prefix (an earlier sweep's) starts at the top.
  const cursor = parsed.success ? parsed.data.cursor : undefined;
  const listed = await env.FILES.list({
    prefix: buildCachePrefix,
    limit: buildSweepBatch,
    ...(cursor === undefined ? {} : { cursor }),
  });
  const old = listed.objects
    .filter(({ uploaded }) => now.getTime() - uploaded.getTime() > buildKeepMs)
    .map(({ key }) => key);
  if (old.length > 0) {
    await env.FILES.delete(old);
  }
  await env.FILES.put(
    buildSweepKey,
    JSON.stringify({
      prefix: buildCachePrefix,
      ...(listed.truncated ? { cursor: listed.cursor } : {}),
    })
  );
};

/** What a build through the cache answered, as the requests sharing it get it. */
type CachedAnswer = Awaited<ReturnType<typeof throughCache>>;

/**
 * The builds running now in this isolate, by whose build and its cache
 * key: a build asked for while the same one runs waits for it rather
 * than start the compiler again, so views of one App's page take one
 * place in the sandbox, not one each. A build whose request was cancelled
 * never settles, so it is waited for only as long as a build may take
 * (`sharedRun`).
 */
const buildsRunning = new Map<string, SharedRun<CachedAnswer>>();

/**
 * The entry `cacheKey` names through the cache, made by `make`, shared by
 * every request of this isolate that asks for it while it is made, for
 * as long as `makeMs` (the calls it makes) may take.
 */
const sharedThroughCache = async (
  env: CacheEnv,
  /** Whose it is: another App asking for the same entry makes its own. */
  whose: string,
  cacheKey: string,
  makeMs: number,
  make: () => Promise<{ text: string; cache: boolean }>
): Promise<CachedAnswer> =>
  await sharedRun(
    buildsRunning,
    `${whose}\n${cacheKey}`,
    makeMs,
    async () => await throughCache(env, cacheKey, make)
  );

/** How long the compiler's and the type checker's calls may take, one after the other. */
const buildMs = (runner: PlatformRunner): number =>
  runner.callMs("compiler") + runner.callMs("type-checker");

/**
 * A build of the files `select` picks, the only ones it reads: limited
 * first, so the limits bound the hashing and sending too. From the cache
 * (build-cache.ts), or built by the compiler and kept there. A failed
 * build is kept too, where the files alone failed it (`compiled`): the
 * same files fail the same way with the same compiler, so an App that
 * doesn't build can't start the compiler on every request. A build that
 * throws isn't kept. Two requests in one isolate share one compile
 * (`buildsRunning`).
 */
const cachedBuild = async <Build>(
  env: BuildEnv,
  kind: BuildKind,
  appFiles: AppFiles,
  select: (files: AppFiles) => AppFiles,
  /** Whose build it is: the App's ID, or an independent workflow's. */
  whose: string,
  { profile = "production", checks = true }: BuildOptions = {}
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
  // compiler call a kind makes (`compilerCalls`) builds again. Under its
  // profile too: a preview's build is never served as production's.
  const [callMethod, callTarget] = compilerCallOf(kind, profile, checks);
  const cacheKey = await cacheKeyOf(`${kind}-build`, [
    callMethod,
    callTarget,
    profile,
    inOrder(files),
  ]);
  const isBuild = (value: unknown): value is Build | FailedBuild =>
    isBuildShaped(value);
  const started = Date.now();
  const { text, outcome } = await sharedThroughCache(
    env,
    // One sub-owner's: another App building the same files builds them in
    // its own part of the builder's share, never on this one's (or with
    // its refusal). The cache itself is by content alone.
    whose,
    cacheKey,
    buildMs(runner),
    async () => {
      const answer =
        kind === "page"
          ? await compiledIncrementally(env, runner, files, { profile, checks })
          : await compiled(runner, kind, files, profile);
      if (!isBuild(answer.built)) {
        throw new TypeError(
          "The compiler answered something else than a build."
        );
      }
      return { text: JSON.stringify(answer.built), cache: answer.cache };
    }
  );
  // Assembly, transforms and execution are the compiler's own; this is
  // the cache's part: how a build came about, and how long it took.
  log.info("build.cache", {
    kind,
    profile,
    outcome: outcome satisfies CacheOutcome,
    ms: Date.now() - started,
  });
  const built: unknown = JSON.parse(text);
  if (!isBuild(built)) {
    throw new TypeError("The compiler answered something else than a build.");
  }
  return built;
};

/**
 * `select`, handing the build the App's approved packages too, bundled for
 * `target` (packages/build.ts `appPackageModules`): what its code may
 * import of npm, and nothing else.
 */
const withPackages = async (
  env: BuildEnv,
  app: string,
  target: PackageTarget,
  select: (files: AppFiles) => AppFiles
): Promise<(files: AppFiles) => AppFiles> => {
  // Refused where nothing bounds a build, before anything is read: as
  // the build itself would be.
  sessionHost(env);
  const bundled = await appPackageModules(env, app, target);
  return bundled === undefined
    ? select
    : (files) => ({ ...select(files), [packageModulesFile]: bundled });
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
    await withPackages(env, whose, "browser", buildFiles),
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
    await withPackages(env, whose, "worker", appCodeFiles),
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
    await withPackages(env, whose, "worker", appCodeAndTestFiles),
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
  const cacheKey = await cacheKeyOf("expression-check", [request]);
  const { text } = await sharedThroughCache(
    env,
    whose,
    cacheKey,
    runner.callMs("type-checker"),
    async () => {
      const diagnostics = await runner.run("type-checker", "check", [request]);
      if (!Array.isArray(diagnostics)) {
        throw new TypeError(
          "The type checker answered something else than diagnostics."
        );
      }
      // A check that couldn't run (tsrs failed, its answer unread) is no
      // verdict on the expressions: thrown, never cached, for the
      // publication to be tried again (workflow-resources.ts).
      const stop: unknown = diagnostics.find(
        (diagnostic: unknown) =>
          typeof diagnostic === "object" &&
          diagnostic !== null &&
          "rule" in diagnostic &&
          diagnostic.rule === "check"
      );
      if (stop !== undefined) {
        throw new Error("The type checker couldn't check the expressions.", {
          cause: stop,
        });
      }
      return { text: JSON.stringify(diagnostics), cache: true };
    }
  );
  // SAFETY: the checker's answer, as core kept it under its MAC.
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
