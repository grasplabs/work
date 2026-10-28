import {
  appCodeFiles,
  appCodeLimitErrors,
  appTestFiles,
  appModuleName,
  buildFiles,
  compilerVersion,
  generatedFolder,
  isAppLayout,
  kitModuleName,
  kitModules,
  kitPreviewModules,
  previewRuntime,
  screenRuntime,
  limitErrors,
  computeModuleErrors,
  computePackagesFile,
  openWorkflowErrors,
  serverFiles,
  workflowBindingsPath,
  workflowBuildFiles,
} from "@grasp-os/compiler";
import type {
  AppCodeBuild,
  CompileTarget,
  Diagnostic,
  InspectTarget,
  ComputeModulesBuild,
  OpenWorkflowBuild,
  ScreenBuild,
  ServerBuild,
  WorkflowBuild,
} from "@grasp-os/compiler";
import {
  generatedPaths,
  serverModuleSource,
  symbolicModules,
} from "@grasp-os/sdk/host";
import { diagnosticCategory } from "@grasp-os/shared/diagnostics";
import { sha256Hex } from "@grasp-os/shared/encoding";
import type { ErrorPayload } from "@grasp-os/shared/errors";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  screenErrors,
  screenNameSchema,
  screenPath,
} from "@grasp-os/shared/screens";
import { sharedRun } from "@grasp-os/shared/shared-runs";
import type { SharedRun } from "@grasp-os/shared/shared-runs";
import { z } from "zod";

import {
  forgetReceipts,
  keySchema,
  refreshKept,
  sweepReceipts,
  throughCache,
} from "./build-cache.ts";
import type { Built, CacheEnv } from "./build-cache.ts";
import { PlatformBoundError, platformRunner } from "./platform-sandbox.ts";
import type { PlatformEnv, PlatformRunner } from "./platform-sandbox.ts";
import type { FrameCode } from "./screen-frame.ts";

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
 * a version that changed only its screens, takes the server build it
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
  if (kind === "open-workflow") {
    return openWorkflowErrors;
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
  CacheEnv & {
    /** Where builds are cached: core's R2 bucket, in the EU. */
    FILES: Pick<R2Bucket, "get" | "put">;
  };

/** How much longer than a build may take a build's lease is held. */
export const leaseSlackMs = 30_000;

/**
 * Which build profile a build is for (spec 19.2.1): `production`, what a
 * version's saves, reviews, seals and opens build; `preview`, what a
 * chat's draft builds, checks and seals. Each profile has cache keys and
 * screen artifact hashes of its own, so a preview build never stands in
 * for a production one, even of the same files.
 */
export type BuildProfile = "preview" | "production";

/** How a build is asked for. */
export interface BuildOptions {
  /** Its profile: `production` unless a chat's draft asks. */
  readonly profile?: BuildProfile;
  /** Given up on: no compile starts, and it throws its reason. */
  readonly signal?: AbortSignal;
}

/**
 * What the compiler (`AppCompiler`) runs for each kind of build: its
 * method and the target. Only inspection (`app`, the server code with
 * stand-in generated modules) is `inspect`; a seal's checked server code
 * (`app-check`) is `build("app")`, with every gate.
 */
const compilerCalls = {
  screen: ["build", "screens"],
  server: ["build", "server"],
  workflow: ["build", "workflows"],
  app: ["inspect", "app"],
  "app-check": ["build", "app"],
  "app-tests": ["build", "app-tests"],
  "open-workflow": ["build", "open-workflow"],
  compute: ["build", "compute"],
} as const satisfies Record<
  string,
  readonly ["build", CompileTarget] | readonly ["inspect", InspectTarget]
>;

/** The kinds of build, by the compiler call each runs. */
type BuildKind = keyof typeof compilerCalls;

/**
 * The compiler call a build of `kind` for `profile` runs: a chat's draft's
 * screens are built instrumented for React Fast Refresh, on the preview
 * kit (spec 19.2.1); every other build is the same for both profiles.
 */
const compilerCallOf = (
  kind: BuildKind,
  profile: BuildProfile
): (typeof compilerCalls)[BuildKind] | readonly ["build", "preview-screens"] =>
  kind === "screen" && profile === "preview"
    ? ["build", "preview-screens"]
    : compilerCalls[kind];

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
 * A build of `files` by the compiler, wherever the runner runs it, and
 * whether to cache it: the compiler's answer, or a failed build when it
 * was stopped at a bound (a type built to recurse, say). A stop the files
 * reach whatever the load (CPU time, memory, an answer too large) is
 * cached as the failed build it is, so an App whose screen holds the
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
  profile: BuildProfile
): Promise<{ built: unknown; cache: boolean }> => {
  try {
    const [method, target] = compilerCallOf(kind, profile);
    const built = await runner.run("compiler", method, [target, files]);
    return { built, cache: true };
  } catch (error) {
    // A JSON workflow's generated module is never its author's to fix,
    // and a stop of compute modules that the load made (a deadline, a
    // crash) isn't either: both are thrown on, for the caller to answer
    // as a build to try again (`workflow.build_slow`).
    if (
      !(error instanceof PlatformBoundError) ||
      kind === "open-workflow" ||
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
const buildRefreshMs = buildKeepMs / 2;

/** Where the builds' sweep left off: which kind, and R2's cursor in it. */
const buildSweepKey = "builds-sweep.json";

/** The most objects one run of the builds' sweep reads. */
const buildSweepBatch = 500;

/** The prefix inspected manifests are cached under (app-inspection.ts). */
export const inspectionsPrefix = "inspections/";

/**
 * The prefix each kind of build is cached under, inspected manifests, and
 * the bad bytes kept for operators (build-cache.ts), which all go after
 * the same time.
 */
const buildPrefixes = [
  ...Object.keys(compilerCalls).map((kind) => `${kind}-builds/`),
  inspectionsPrefix,
  "build-quarantine/",
];

const buildSweepSchema = z.object({
  prefix: z
    .int()
    .min(0)
    .max(buildPrefixes.length - 1),
  cursor: z.string().optional(),
});

/** What a cached build is written with: when it was last used. */
const usedNow = (): R2PutOptions => ({
  customMetadata: { usedAt: String(Date.now()) },
});

/**
 * When a cached build was last used: as it was last written, or, for one
 * written before builds said so, when it was uploaded.
 */
const lastUsedOf = (object: R2Object): number => {
  const usedAt = Number(object.customMetadata?.usedAt);
  return Number.isFinite(usedAt) && usedAt > 0
    ? usedAt
    : object.uploaded.getTime();
};

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
  const prefix = buildPrefixes[state.prefix] ?? "screen-builds/";
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
  build: () => Promise<Built>,
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
 * compiler again, so views of one App's screen take one place in the
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
 * them all, so concurrent views of one screen compile once. A request
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
  { profile = "production", signal }: BuildOptions = {}
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
  const [callMethod, callTarget] = compilerCallOf(kind, profile);
  const cacheKey = `${kind}-builds/${callMethod}.${callTarget}/${keySchema}/${profile}/${await buildKey(files)}.json`;
  const isBuild = (value: unknown): value is Build | FailedBuild =>
    isBuildShaped(value);
  const started = Date.now();
  const leaseMs = runner.callMs("compiler") + leaseSlackMs;
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
        async () => {
          const answer = await compiled(runner, kind, files, profile);
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
 * Builds an App's screens into ES modules and their CSS, in the compiler's
 * isolate. The modules import the release's kit modules (`kitModules(env.ASSETS)`);
 * `screens` in the result names the ones each screen needs. A build is
 * cached in R2.
 */
export const buildScreens = async (
  env: BuildEnv,
  appFiles: AppFiles,
  /** Whose build it is: the App's ID. */
  whose: string,
  options?: BuildOptions
): Promise<ScreenBuild> =>
  await cachedBuild<ScreenBuild>(
    env,
    "screen",
    appFiles,
    buildFiles,
    whose,
    options
  );

/**
 * Builds an App's server code (`app/**.ts`) into ES modules, in the
 * compiler's isolate. A build is cached in R2, like the screens'.
 */
export const buildServer = async (
  env: BuildEnv,
  appFiles: AppFiles,
  /** Whose build it is: the App's ID. */
  whose: string,
  options?: BuildOptions
): Promise<ServerBuild> =>
  await cachedBuild<ServerBuild>(
    env,
    "server",
    appFiles,
    serverFiles,
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

/** An App's server code with its tests: what `checkAppCode` reads. */
const appCodeAndTestFiles = (files: AppFiles): AppFiles => ({
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
 * What a workflow build reads (`workflowBuildFiles`): the App's
 * workflows, and the server code their types may name, with the host's
 * generated modules as inspection has them: the constructors, the same
 * for every App, and stand-ins for the references. Everything under
 * `.grasp/` is the host's: a save refuses an App's own file there (no
 * path segment starts with a dot, `appPathSchema`), and whatever a
 * version holds there anyway is dropped here, so only the host's
 * modules, and the binding names it gives, reach the type check.
 */
const workflowInputs = (files: AppFiles): AppFiles => {
  const selected = Object.fromEntries(
    Object.entries(workflowBuildFiles(files)).filter(
      ([path]) => !path.startsWith(generatedFolder)
    )
  );
  return isAppLayout(selected)
    ? {
        ...selected,
        ...symbolicModules(),
        [generatedPaths.server]: serverModuleSource,
      }
    : selected;
};

/**
 * Builds an App's workflows (`workflows/**.ts`) into ES modules, in the
 * compiler's isolate, type-checked with the server code their types may
 * name, and their `env` typed by `bindings`: each binding name the App's
 * permissions hold, as the kind of binding it is (`workflowBindingKinds`,
 * permissions.ts); any other name answers `unknown`. A
 * build is cached in R2, like the server's, by its inputs, the bindings
 * among them.
 */
export const buildWorkflows = async (
  env: BuildEnv,
  appFiles: AppFiles,
  /** Whose build it is: the App's ID. */
  whose: string,
  bindings: Readonly<Record<string, string>>,
  options?: BuildOptions
): Promise<WorkflowBuild> =>
  await cachedBuild<WorkflowBuild>(
    env,
    "workflow",
    appFiles,
    (files) => ({
      ...workflowInputs(files),
      [workflowBindingsPath]: JSON.stringify(
        Object.fromEntries(
          Object.entries(bindings).toSorted(([one], [other]) =>
            one.localeCompare(other)
          )
        )
      ),
    }),
    whose,
    options
  );

/**
 * Builds the module the host generated from a JSON workflow
 * (`.grasp/workflow.ts`, workflow-builds.ts) into one ES module, in the
 * compiler's isolate, type-checked against its SDK. Cached in R2 like the
 * others: the same generated module builds the same with the same
 * compiler, so identical definitions share one build.
 */
export const buildOpenWorkflow = async (
  env: BuildEnv,
  files: AppFiles,
  /** Whose build it is: the independent workflow's ID. */
  whose: string
): Promise<OpenWorkflowBuild> =>
  await cachedBuild<OpenWorkflowBuild>(
    env,
    "open-workflow",
    files,
    (all) => all,
    whose
  );

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

/** A screen as core built it: its name, its code, and the hash of that code. */
export interface BuiltScreen {
  screen: string;
  code: FrameCode;
  /** `code`'s hash under its profile (`screenArtifact`): what an admin approves. */
  artifact: string;
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
        throw new Error(`The screen's build names ${name}, which is missing.`);
      }
      return [name, code];
    })
  );

/**
 * The hash of a screen's code built for `profile`: what an admin
 * approves, and what its frame is staged under. The profile is part of
 * it, so a preview's artifact never passes for production's.
 */
export const screenArtifact = async (
  profile: BuildProfile,
  { entry, runtime, modules, kit, css }: FrameCode
): Promise<string> =>
  await sha256Hex(
    canonicalJson({ profile, code: { entry, runtime, modules, kit, css } })
  );

/** The screens of a version, built once, for each screen's code. */
export type VersionScreens = (screen: unknown) => Promise<BuiltScreen>;

/**
 * Builds the screens of an App's `files` (at `version`; null for a chat's
 * draft) once, within the build wait, the kit's modules too: whoever asked
 * hears `screen.build_slow` rather than wait on a build that doesn't
 * answer, and `screen.build_failed` when it doesn't build. All screens
 * build together, so one build serves each of them: the answer gives each
 * screen's code from it (`screenCode` for one). Files with no screen
 * build nothing (the compiler would refuse them): there is no screen's
 * code to give.
 */
export const versionScreens = async (
  env: Env,
  files: Record<string, string>,
  version: number | null,
  /** Whose screens they are: the App's ID. */
  app: string,
  /** `preview` for a chat's draft. */
  profile: BuildProfile
): Promise<VersionScreens> => {
  if (!Object.keys(files).some((path) => screenPath.test(path))) {
    return async () => {
      await Promise.resolve();
      throw screenErrors.create("screen.not_found");
    };
  }
  const loaded = await withinBuildWait(
    env,
    async () =>
      await Promise.all([
        buildScreens(env, files, app, { profile }),
        // A preview runs on the preview kit (spec 19.2.1), which its
        // build's closures name.
        profile === "preview"
          ? kitPreviewModules(env.ASSETS)
          : kitModules(env.ASSETS),
      ])
  );
  if (loaded === "late") {
    throw screenErrors.create("screen.build_slow");
  }
  const [build, { modules: kit }] = loaded;
  if (!build.ok) {
    throw screenErrors.create(
      "screen.build_failed",
      buildFailed(version, build)
    );
  }
  return async (screen) => {
    const name = screenErrors.parse("screen.invalid", screenNameSchema, screen);
    const path = `screens/${name}.tsx`;
    if (!Object.hasOwn(files, path)) {
      throw screenErrors.create("screen.not_found");
    }
    const entry = appModuleName(path);
    const closure = build.screens[entry];
    if (closure === undefined) {
      // The file is there and the build passed: the build is at fault.
      throw new Error(`The build has no closure for the screen in ${path}.`);
    }
    const code = {
      entry,
      runtime: kitModuleName(
        profile === "preview" ? previewRuntime : screenRuntime
      ),
      modules: pick(build.modules, closure.modules),
      kit: pick(kit, closure.kitModules),
      css: build.css,
    };
    // Which code a frame runs, in core's words: what an admin approves,
    // what the frame's document runs and nothing else (screen-frame.ts),
    // and what the page expects the frame to say back once the screen has
    // mounted (screen-host.ts).
    return {
      screen: name,
      code,
      artifact: await screenArtifact(profile, code),
    };
  };
};

/**
 * Screen `screen` of an App's `files` (at `version`; null for a chat's
 * draft), built, with what it loads and nothing else: its own module and
 * the App's and the kit's modules it imports, not the App's other screens
 * or the rest of the kit. A name that isn't one of its screens is refused
 * before anything builds.
 */
export const screenCode = async (
  env: Env,
  files: Record<string, string>,
  screen: unknown,
  version: number | null,
  /** Whose screen it is: the App's ID. */
  app: string,
  /** `preview` for a chat's draft. */
  profile: BuildProfile
): Promise<BuiltScreen> => {
  const name = screenErrors.parse("screen.invalid", screenNameSchema, screen);
  if (!Object.hasOwn(files, `screens/${name}.tsx`)) {
    throw screenErrors.create("screen.not_found");
  }
  const built = await versionScreens(env, files, version, app, profile);
  return await built(name);
};
