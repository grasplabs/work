import {
  appCodeFiles,
  buildFiles,
  generatedFolder,
  workflowFiles,
} from "@grasp-os/compiler";
import type { Diagnostic } from "@grasp-os/compiler";
import {
  generatedPaths,
  generateModules,
  serverModuleSource,
  symbolicModules,
} from "@grasp-os/sdk/host";
import type { AppManifest } from "@grasp-os/sdk/host";
import type {
  BuildDiagnostic,
  CommittedVersion,
  SavedBuild,
} from "@grasp-os/shared/apps";
import { appErrors, appV1ServerFolder } from "@grasp-os/shared/apps";
import { diagnosticCategory } from "@grasp-os/shared/diagnostics";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";
import { log } from "@grasp-os/shared/log";

import { filesManifest } from "./app-inspection.ts";
import { boundWorkflowsOf } from "./bound-workflows.ts";
import { withDraftReferences } from "./draft-references.ts";
import type { WorkflowBindingKind } from "./permissions.ts";
import {
  buildAppCode,
  buildScreens,
  buildWorkflows,
  checkAppCode,
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

/** What a save says of a build that didn't answer within its wait. */
const tookTooLong =
  "The build didn't finish in time. It runs again when this is first used.";

/** A saved version: its App and number, for the log, and its files. */
interface SavedSource {
  app: AppId;
  version: number;
  files: Record<string, string>;
  /**
   * The binding names its workflows are typed by: a committed version's
   * own (`workflowBindingKinds`), or for a draft the App's now
   * (`appBindingKinds`), as a version committed from it would keep.
   */
  bindings: Readonly<Record<string, WorkflowBindingKind>>;
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
  kind: keyof SavedBuilds | "server",
  { app, version, files }: Pick<SavedSource, "app" | "version" | "files">,
  select: (files: Record<string, string>) => Record<string, string>,
  build: () => Promise<{ ok: boolean; diagnostics?: Diagnostic[] }>,
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
    return {
      status: built.ok ? "ok" : "failed",
      diagnostics: (built.diagnostics ?? []).map((item) => toDiagnostic(item)),
    };
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
 * Builds a saved version's screens and workflows, both at once, into the
 * build cache (screens.ts), so the version opens and runs without
 * building. Answers once both are done with how each
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
  }: {
    /** `preview` for a chat's draft, `production` for a saved version. */
    readonly profile: BuildProfile;
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
  const [screens, workflows] = await Promise.all([
    savedBuild(
      "screens",
      source,
      buildFiles,
      // With the references its screens import, generated from these
      // files themselves: neither a save nor a draft is sealed yet.
      async () =>
        await buildScreens(
          env,
          await withDraftReferences(
            env,
            source.app,
            source.version,
            files,
            options
          ),
          source.app,
          options
        ),
      env,
      signal
    ),
    savedBuild(
      "workflows",
      source,
      workflowFiles,
      async () =>
        await buildWorkflows(env, files, source.app, source.bindings, options),
      env,
      signal
    ),
  ]);
  return { screens, workflows };
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

/**
 * Why inspecting server code that builds refused it, as one diagnostic:
 * what its registration threw, or the SDK's reason its manifest doesn't
 * read.
 */
const inspectionProblem = (
  error: Error & { details?: unknown }
): Diagnostic => {
  const { details } = error;
  const said =
    typeof details === "object" &&
    details !== null &&
    "message" in details &&
    typeof details.message === "string"
      ? details.message
      : "";
  return {
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
 * the seal's type check passes too. Server code that doesn't build or
 * register fails on what its build says, or, when it builds, on why its
 * inspection refused it.
 */
const checkedDraftCode = async (
  env: Env,
  { app, version, files }: Pick<SavedSource, "app" | "version" | "files">,
  signal?: AbortSignal
): Promise<{ ok: boolean; diagnostics?: Diagnostic[] }> => {
  // Whatever the draft holds under `.grasp/` is the host's to generate.
  const code = Object.fromEntries(
    Object.entries(files).filter(([path]) => !path.startsWith(generatedFolder))
  );
  const options = { profile: "preview", signal } as const;
  let manifest: AppManifest;
  try {
    manifest = await filesManifest(env, code, app, options);
  } catch (error) {
    if (!isExpectedError(error)) {
      throw error;
    }
    // Its build, as inspection built it (from the build cache): what fails
    // there, or else why inspection refused it.
    const built = await buildAppCode(
      env,
      {
        ...code,
        ...symbolicModules(),
        [generatedPaths.server]: serverModuleSource,
      },
      app,
      options
    );
    return built.ok
      ? { ok: false, diagnostics: [inspectionProblem(error)] }
      : built;
  }
  const generated = await generateModules(
    manifest,
    { resourceId: app, resourceVersion: version },
    await boundWorkflowsOf(env, app, manifest)
  );
  return await checkAppCode(env, { ...code, ...generated }, app, options);
};

/**
 * A draft's server code (`app.ts`, `schema.ts`, `values.ts`,
 * `operations/`, `migrations/`), checked as a check reports it: type
 * errors and every gate a seal holds it to, against the references its
 * seal would generate (`checkedDraftCode`); its registration runs in the
 * sandbox to say what they are, none of its operations (server code with
 * no app.ts and schema.ts fails there, saying so). Failed too when it
 * holds files under `app/`, which no commit takes (`app.v1_server`), each
 * named; `none` when it has no server code. Never throws, unless `signal`
 * gave up on it, as `buildOnSave`.
 */
export const draftServerBuild = async (
  env: Env,
  source: Pick<SavedSource, "app" | "version" | "files">,
  signal?: AbortSignal
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
    async () => await checkedDraftCode(env, source, signal),
    env,
    signal
  );
};
