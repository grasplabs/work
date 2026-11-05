import {
  appCodeFiles,
  buildFiles,
  isGeneratedPath,
  isLintedCode,
} from "@grasp-os/compiler";
import type { Diagnostic } from "@grasp-os/compiler";
import { generateModules, symbolicModules } from "@grasp-os/sdk/host";
import type {
  BuildDiagnostic,
  CommittedVersion,
  SavedBuild,
} from "@grasp-os/shared/apps";
import { appErrors, appV1ServerFolder } from "@grasp-os/shared/apps";
import { diagnosticCategory } from "@grasp-os/shared/diagnostics";
import type { AppId } from "@grasp-os/shared/ids";
import { log } from "@grasp-os/shared/log";
import { z } from "zod";

import { boundWorkflowsOf } from "./bound-workflows.ts";
import { inspectDraft, withDraftReferences } from "./draft-references.ts";
import type { DraftInspection } from "./draft-references.ts";
import { hostModules } from "./host-modules.ts";
import { keepLints, readLints } from "./module-cache.ts";
import { platformRunner } from "./platform-sandbox.ts";
import {
  buildRefreshMs,
  buildScreens,
  checkAppCode,
  leaseSlackMs,
  withinBuildWait,
} from "./screens.ts";
import type { BuildProfile } from "./screens.ts";

type SavedBuilds = CommittedVersion["builds"];

/** What a save says of a build that couldn't run; nothing of App code. */
const couldNotRun =
  "The build couldn't run now. It runs again when this is first used.";

/**
 * Most files under `app/` a draft's server build names: as many as its
 * refusal names when committed (app-v1-server.ts).
 */
const maxLeftoversNamed = 20;

/**
 * The most characters of a failed build's error message the warning
 * keeps: enough to tell the compiler unreachable, out of CPU or refused
 * apart, without logging a long message whole.
 */
const maxLoggedMessage = 300;

/**
 * What a save says of screens checked against stand-ins for the references
 * their server code didn't generate (`standIn`): checked for everything
 * else, never for their calls, so not checked as a whole.
 */
const checkedOnStandIns =
  "Checked without the references the server code generates, as it doesn't register yet: fix the server code and save again.";

/** What a save says of a build that didn't answer within its wait. */
const tookTooLong =
  "The build didn't finish in time. It runs again when this is first used.";

/** A saved version: its App and number, for the log, and its files. */
interface SavedSource {
  app: AppId;
  version: number;
  files: Record<string, string>;
}

const toDiagnostic = ({
  file,
  line,
  column,
  rule,
  severity,
  message,
  fix,
}: Diagnostic): BuildDiagnostic => ({
  file: file ?? null,
  line: line ?? null,
  ...(column === undefined ? {} : { column }),
  rule,
  category: diagnosticCategory(rule),
  severity,
  message,
  ...(fix === undefined ? {} : { fix }),
});

/**
 * One build of saved files, as the save reports it: `none` when there is
 * nothing of its kind to build, and `error` when the build threw (the
 * compiler couldn't be reached, or ran out of CPU) or didn't answer within
 * the build wait (`withinBuildWait`): it runs again at its first use.
 */
const savedBuild = async (
  kind: keyof SavedBuilds | "server" | "lint",
  { app, version, files }: Pick<SavedSource, "app" | "version" | "files">,
  select: (files: Record<string, string>) => Record<string, string>,
  build: () => Promise<{
    ok: boolean;
    diagnostics?: Diagnostic[];
    standIn?: true;
  }>,
  env: Env,
  signal?: AbortSignal
): Promise<SavedBuild> => {
  try {
    if (Object.keys(select(files)).length === 0) {
      return { status: "none", diagnostics: [] };
    }
    const built = await withinBuildWait(env, build);
    if (built === "late") {
      log.warn("app.save_build_timed_out", { appId: app, version, kind });
      return { status: "error", diagnostics: [], error: tookTooLong };
    }
    const diagnostics = (built.diagnostics ?? []).map((item) =>
      toDiagnostic(item)
    );
    // Never `ok` on stand-ins, so whoever reads the status alone isn't
    // misled: `error` (not checked) with why, or `failed` for what it found.
    if (built.standIn === true) {
      return {
        status: built.ok ? "error" : "failed",
        diagnostics,
        error: checkedOnStandIns,
        standIn: true,
      };
    }
    return { status: built.ok ? "ok" : "failed", diagnostics };
  } catch (error) {
    // Given up on, not failed: whoever gave up on it hears why.
    if (signal?.aborted === true) {
      throw signal.reason;
    }
    log.warn("app.save_build_failed", {
      appId: app,
      version,
      kind,
      errorName: error instanceof Error ? error.name : typeof error,
      // Why it couldn't run (the compiler unreachable, a Loader or asset
      // error, a sandbox stop): the name alone doesn't say which. Never
      // the stack, and cut short.
      ...(error instanceof Error
        ? { errorMessage: error.message.slice(0, maxLoggedMessage) }
        : {}),
    });
    return { status: "error", diagnostics: [], error: couldNotRun };
  }
};

/**
 * Builds a saved version's screens into the build cache (screens.ts), so
 * the version opens without building. Answers once done with how it
 * went, for whoever saved (an agent repairs what failed); none takes
 * longer than the build wait (`buildWaitMs` in screens.ts). Never throws, unless `signal` gave up on it: a build is never a reason
 * for a save to fail.
 */
export const buildOnSave = async (
  env: Env,
  source: SavedSource,
  {
    profile,
    signal,
    inspection,
  }: {
    /** `preview` for a chat's draft, `production` for a saved version. */
    readonly profile: BuildProfile;
    /**
     * The inspection of its server code the references its screens import
     * are generated from (`inspectDraft`), when its caller shares one with
     * the server check: its own otherwise.
     */
    readonly inspection?: () => Promise<DraftInspection>;
    /**
     * Aborted once the build is no one's (a build job's lease lost): no
     * build starts the compiler after, and it throws its reason, rather
     * than report the builds it gave up as errors. A compile already
     * running goes on (screens.ts, `cachedBuild`).
     */
    readonly signal?: AbortSignal;
  }
): Promise<SavedBuilds> => {
  const { files } = source;
  const options = { profile, signal };
  const screens = await savedBuild(
    "screens",
    source,
    buildFiles,
    // With the references its screens import, generated from these
    // files themselves: neither a save nor a draft is sealed yet.
    async () => {
      const { files: withReferences, standIn } = await withDraftReferences(
        env,
        source.app,
        source.version,
        files,
        options,
        inspection
      );
      const built = await buildScreens(
        env,
        withReferences,
        source.app,
        options
      );
      return standIn ? { ...built, standIn: true as const } : built;
    },
    env,
    signal
  );
  return { screens };
};

/** A diagnostic of the App's layout (`server`) about `file`, in core's words. */
const layoutProblem = (file: string, message: string): BuildDiagnostic => ({
  file,
  line: null,
  rule: "server",
  category: diagnosticCategory("server"),
  severity: "error",
  message,
});

/** Where inspecting server code located what it threw (app-inspection.ts). */
const inspectionDetailsSchema = z.object({
  message: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
});

/**
 * Why inspecting server code that builds refused it, as one diagnostic:
 * what its registration threw, at the line of the App's file it threw
 * from when its stack named one, or the SDK's reason its manifest doesn't
 * read.
 */
const inspectionProblem = (
  error: Error & { details?: unknown }
): Diagnostic => {
  const details = inspectionDetailsSchema.safeParse(error.details);
  const { message: said = "", ...at } = details.success ? details.data : {};
  return {
    ...at,
    rule: "server",
    severity: "error",
    message: said === "" ? error.message : `${error.message} ${said}`,
  };
};

/**
 * `files`' server code type-checked as its seal type-checks it
 * (`checkAppCode`, with every gate), against the references the seal
 * generates: from what its registration answers, inspected in the sandbox
 * as a save inspects it for its screens (`filesManifest`), with the
 * workflows it declares as the App binds them now. So what a check passes,
 * the seal's type check passes too. `inspection` is the one its screens'
 * references come from too, when its caller shares one (`inspectDraft`).
 *
 * Server code that doesn't build or register is type-checked all the same,
 * against the stand-ins inspection loads (`symbolicModules`, typed `any`):
 * what doesn't build, its type errors, and why its registration threw
 * come back together, never one hiding another, and never one error per
 * file that names a reference.
 */
const checkedDraftCode = async (
  env: Env,
  { app, version, files }: Pick<SavedSource, "app" | "version" | "files">,
  inspection: () => Promise<DraftInspection>,
  signal?: AbortSignal
): Promise<{ ok: boolean; diagnostics?: Diagnostic[] }> => {
  // Whatever the draft holds under `.grasp/` is the host's to generate.
  const code = Object.fromEntries(
    Object.entries(files).filter(([path]) => !isGeneratedPath(path))
  );
  const options = { profile: "preview", signal } as const;
  const inspected = await inspection();
  if ("failed" in inspected) {
    const { failed: error } = inspected;
    const checked = await checkAppCode(
      env,
      {
        ...code,
        ...symbolicModules(),
        ...hostModules,
      },
      app,
      options
    );
    // What doesn't build, the check names with its type errors; what
    // built but didn't register, inspection says.
    return Reflect.get(error, "code") === "version.build_failed"
      ? checked
      : {
          ok: false,
          diagnostics: [
            inspectionProblem(error),
            ...(checked.ok ? [] : checked.diagnostics),
          ],
        };
  }
  const { manifest } = inspected;
  const generated = await generateModules(
    manifest,
    { resourceId: app, resourceVersion: version },
    await boundWorkflowsOf(env, app, manifest)
  );
  return await checkAppCode(env, { ...code, ...generated }, app, options);
};

/**
 * A draft's server code (`app.ts`, `schema.ts`, `values.ts`,
 * `server/`), checked as a check reports it: type
 * errors and every gate a seal holds it to, against the references its
 * seal would generate (`checkedDraftCode`); its registration runs in the
 * sandbox to say what they are, none of its operations (server code with
 * no app.ts and schema.ts fails there, saying so). Failed too when it
 * holds files under `app/`, which no commit takes (`app.v1_server`), each
 * named; `none` when it has no server code. Never throws, unless `signal`
 * gave up on it, as `buildOnSave`. `inspection` is the one its caller
 * shares with the screens' build (`inspectDraft`), its own otherwise.
 */
export const draftServerBuild = async (
  env: Env,
  source: Pick<SavedSource, "app" | "version" | "files">,
  signal?: AbortSignal,
  inspection: () => Promise<DraftInspection> = async () =>
    await inspectDraft(env, source.app, source.files, {
      profile: "preview",
      signal,
    })
): Promise<SavedBuild> => {
  const { files } = source;
  const leftovers = Object.keys(files)
    .filter((path) => path.startsWith(appV1ServerFolder))
    .toSorted();
  if (leftovers.length > 0) {
    const refused = appErrors.create("app.v1_server").message;
    return {
      status: "failed",
      diagnostics: leftovers
        .slice(0, maxLeftoversNamed)
        .map((path) => layoutProblem(path, refused)),
    };
  }
  return await savedBuild(
    "server",
    source,
    appCodeFiles,
    async () => await checkedDraftCode(env, source, inspection, signal),
    env,
    signal
  );
};

/**
 * The files Ultracite's rules read (`lint`): the App's TypeScript, but its
 * declarations and what core generates.
 */
const lintedFiles = (files: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files).filter(
      ([path]) => isLintedCode(path) && !isGeneratedPath(path)
    )
  );

const diagnosticSchema = z.object({
  file: z.string().optional(),
  line: z.number().optional(),
  column: z.number().optional(),
  rule: z.string(),
  severity: z.enum(["error", "warning"]),
  message: z.string(),
  fix: z.string().optional(),
});

/** What Ultracite's `lint` answers: each file's diagnostics, by path. */
const lintedSchema = z.record(z.string(), z.array(diagnosticSchema));

/**
 * What Ultracite's rules say of a draft's TypeScript (Ultracite's
 * `lint`): a build of its own, in an isolate of its own, so it runs beside
 * the others rather than after them. Each file's result is kept under the
 * key of its content (module-cache.ts), so a write lints only the files
 * that changed. Failed while any of its errors is left; its warnings stay
 * warnings. Never throws, unless `signal` gave up on it, as `buildOnSave`.
 */
export const draftLintBuild = async (
  env: Env,
  source: Pick<SavedSource, "app" | "version" | "files">,
  signal?: AbortSignal
): Promise<SavedBuild> => {
  const built = await savedBuild(
    "lint",
    source,
    lintedFiles,
    async () => {
      const files = lintedFiles(source.files);
      const kept = await readLints(env, files, buildRefreshMs);
      const missing = Object.fromEntries(
        Object.entries(files).filter(([path]) => !Object.hasOwn(kept, path))
      );
      let linted: Record<string, Diagnostic[]> = {};
      if (Object.keys(missing).length > 0) {
        const runner = platformRunner(env, source.app);
        linted = lintedSchema.parse(
          await runner.run("ultracite", "lint", [missing])
        );
        await keepLints(
          env,
          missing,
          linted,
          runner.callMs("ultracite") + leaseSlackMs
        );
      }
      const diagnostics = Object.keys(files)
        .toSorted()
        .flatMap((path) => kept[path] ?? linted[path] ?? []);
      return {
        ok: diagnostics.every(({ severity }) => severity !== "error"),
        diagnostics,
      };
    },
    env,
    signal
  );
  return {
    ...built,
    diagnostics: built.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      category: "code" as const,
    })),
  };
};
