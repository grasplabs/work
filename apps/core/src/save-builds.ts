import { buildFiles, serverFiles, workflowFiles } from "@grasp-os/compiler";
import type { Diagnostic } from "@grasp-os/compiler";
import type {
  BuildDiagnostic,
  CommittedVersion,
  SavedBuild,
} from "@grasp-os/shared/apps";
import { diagnosticCategory } from "@grasp-os/shared/diagnostics";
import type { AppId } from "@grasp-os/shared/ids";
import { log } from "@grasp-os/shared/log";

import { withDraftReferences } from "./draft-references.ts";
import {
  buildScreens,
  buildServer,
  buildWorkflows,
  withinBuildWait,
} from "./screens.ts";

type SavedBuilds = CommittedVersion["builds"];

/** What a save says of a build that couldn't run; nothing of App code. */
const couldNotRun =
  "The build couldn't run now. It runs again when this is first used.";

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
  kind: keyof SavedBuilds,
  { app, version, files }: SavedSource,
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
    });
    return { status: "error", diagnostics: [], error: couldNotRun };
  }
};

/**
 * Builds a saved version's screens, server code and workflows, all at
 * once, into the build cache (screens.ts), so the version opens, answers
 * and runs without building. Answers once all three are done with how each
 * went, for whoever saved (an agent repairs what failed); none takes
 * longer than the build wait (`buildWaitMs` in screens.ts). Never throws, unless `signal` gave up on it: a build is never a reason
 * for a save to fail.
 */
export const buildOnSave = async (
  env: Env,
  source: SavedSource,
  /**
   * Aborted once the build is no one's (a build job's lease lost): no
   * build starts the compiler after, and it throws its reason, rather than
   * report the builds it gave up as errors. A compile already running
   * goes on (screens.ts, `cachedBuild`).
   */
  signal?: AbortSignal
): Promise<SavedBuilds> => {
  const { files } = source;
  const [screens, server, workflows] = await Promise.all([
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
            signal
          ),
          source.app,
          signal
        ),
      env,
      signal
    ),
    savedBuild(
      "server",
      source,
      serverFiles,
      async () => await buildServer(env, files, source.app, signal),
      env,
      signal
    ),
    savedBuild(
      "workflows",
      source,
      workflowFiles,
      async () => await buildWorkflows(env, files, source.app, signal),
      env,
      signal
    ),
  ]);
  return { screens, server, workflows };
};
