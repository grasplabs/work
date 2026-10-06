import {
  appModuleName,
  buildFiles,
  compilerVersion,
  kitModuleName,
  kitModules,
  screenRuntime,
  limitErrors,
  serverFiles,
  startScreenCompiler,
  workflowFiles,
} from "@grasp-os/compiler";
import type {
  Diagnostic,
  ScreenBuild,
  ServerBuild,
  WorkflowBuild,
} from "@grasp-os/compiler";
import { sha256Hex } from "@grasp-os/shared/encoding";
import type { ErrorPayload } from "@grasp-os/shared/errors";
import { canonicalJson } from "@grasp-os/shared/json";
import { screenErrors, screenNameSchema } from "@grasp-os/shared/screens";

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
const buildKey = async (files: AppFiles): Promise<string> =>
  `${compilerVersion}/${await hashOf(files)}`;

/** A build refused before it started, or one that failed. */
interface FailedBuild {
  ok: false;
  diagnostics: Diagnostic[];
}

/**
 * A build of the files `select` picks, the only ones it reads: limited
 * first, so the limits bound the hashing and sending too. From R2 (in the
 * EU), or built in the compiler's isolate and stored there. A failed build
 * is cached too: the same files fail the same way with the same compiler,
 * so an App that doesn't build can't start the compiler on every request.
 * A build that throws isn't cached. Two requests for a build that isn't
 * cached yet may both build it; they build the same thing.
 */
const cachedBuild = async <Build>(
  env: Env,
  kind: "screen" | "server" | "workflow",
  appFiles: AppFiles,
  select: (files: AppFiles) => AppFiles,
  build: (
    compiler: ReturnType<typeof startScreenCompiler>,
    files: AppFiles
  ) => Promise<Build>
): Promise<Build | FailedBuild> => {
  const files = select(appFiles);
  const tooMuch = limitErrors(files);
  if (tooMuch.length > 0) {
    return { ok: false, diagnostics: tooMuch };
  }
  const cacheKey = `${kind}-builds/${await buildKey(files)}.json`;
  const cached = await env.FILES.get(cacheKey);
  if (cached) {
    return await cached.json<Build>();
  }
  const compiler = startScreenCompiler(env.LOADER, env.ASSETS);
  const built = await build(compiler, files);
  await env.FILES.put(cacheKey, JSON.stringify(built));
  return built;
};

/**
 * Builds an App's screens into ES modules and their CSS, in the compiler's
 * isolate. The modules import the release's kit modules (`kitModules(env.ASSETS)`);
 * `screens` in the result names the ones each screen needs. A build is
 * cached in R2.
 */
export const buildScreens = async (
  env: Env,
  appFiles: AppFiles
): Promise<ScreenBuild> =>
  await cachedBuild(
    env,
    "screen",
    appFiles,
    buildFiles,
    async (compiler, files) => await compiler.build(files)
  );

/**
 * Builds an App's server code (`app/**.ts`) into ES modules, in the
 * compiler's isolate. A build is cached in R2, like the screens'.
 */
export const buildServer = async (
  env: Env,
  appFiles: AppFiles
): Promise<ServerBuild> =>
  await cachedBuild(
    env,
    "server",
    appFiles,
    serverFiles,
    async (compiler, files) => await compiler.buildServer(files)
  );

/**
 * Builds an App's workflows (`workflows/**.ts`) into ES modules, in the
 * compiler's isolate. A build is cached in R2, like the server's.
 */
export const buildWorkflows = async (
  env: Env,
  appFiles: AppFiles
): Promise<WorkflowBuild> =>
  await cachedBuild(
    env,
    "workflow",
    appFiles,
    workflowFiles,
    async (compiler, files) => await compiler.buildWorkflows(files)
  );

/** The details of a `*.build_failed` error: the version (null for a draft), and why. */
export const buildFailed = (
  version: number | null,
  { diagnostics }: FailedBuild
): NonNullable<ErrorPayload["details"]> => ({
  version,
  diagnostics: diagnostics.map(({ file, line, message }) => ({
    file: file ?? null,
    line: line ?? null,
    message,
  })),
});

/** A screen as core built it: its name, its code, and the hash of that code. */
export interface BuiltScreen {
  screen: string;
  code: FrameCode;
  /** The SHA-256, in hex, of `code`: what an admin approves. */
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

/** The screens of a version, built once, for each screen's code. */
export type VersionScreens = (screen: unknown) => Promise<BuiltScreen>;

/**
 * Builds the screens of an App's `files` (at `version`; null for a chat's
 * draft) once, within the build wait, the kit's modules too: whoever asked
 * hears `screen.build_slow` rather than wait on a build that doesn't
 * answer, and `screen.build_failed` when it doesn't build. All screens
 * build together, so one build serves each of them: the answer gives each
 * screen's code from it (`screenCode` for one).
 */
export const versionScreens = async (
  env: Env,
  files: Record<string, string>,
  version: number | null
): Promise<VersionScreens> => {
  const loaded = await withinBuildWait(
    env,
    async () =>
      await Promise.all([buildScreens(env, files), kitModules(env.ASSETS)])
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
      runtime: kitModuleName(screenRuntime),
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
      artifact: await sha256Hex(canonicalJson(code)),
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
  version: number | null
): Promise<BuiltScreen> => {
  const name = screenErrors.parse("screen.invalid", screenNameSchema, screen);
  if (!Object.hasOwn(files, `screens/${name}.tsx`)) {
    throw screenErrors.create("screen.not_found");
  }
  const built = await versionScreens(env, files, version);
  return await built(name);
};
