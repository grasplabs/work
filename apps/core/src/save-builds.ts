import {
  appCodeFiles,
  buildFiles,
  isGeneratedPath,
  isDesignRule,
  isLintedCode,
} from "@grasp-os/compiler";
import type { Diagnostic } from "@grasp-os/compiler";
import {
  serverFunctionsIn,
  undeclaredFunctions,
} from "@grasp-os/runtime/definition";
import { generateModules, symbolicModules } from "@grasp-os/runtime/host";
import type { BuildDiagnostic, SavedBuild } from "@grasp-os/shared/apps";
import { diagnosticCategory } from "@grasp-os/shared/diagnostics";
import type { AppId } from "@grasp-os/shared/ids";
import { log } from "@grasp-os/shared/log";
import { z } from "zod";

import { generatedPaths } from "./app-definition.ts";
import { batchesOf, callSplitting, ultraciteBatch } from "./batches.ts";
import { keepLints, readLints } from "./build-cache.ts";
import { inspectDraft, withDraftReferences } from "./draft-references.ts";
import type { DraftInspection } from "./draft-references.ts";
import { hostModules } from "./host-modules.ts";
import { buildPages, checkAppCode, withinBuildWait } from "./pages.ts";
import type { BuildProfile } from "./pages.ts";
import { platformRunner } from "./platform-sandbox.ts";

/** How the builds of a saved version went. */
interface SavedBuilds {
  pages: SavedBuild;
}

/** What a save says of a build that couldn't run; nothing of App code. */
const couldNotRun =
  "The build couldn't run now. It runs again when this is first used.";

/**
 * The most characters of a failed build's error message the warning
 * keeps: enough to tell the compiler unreachable, out of CPU or refused
 * apart, without logging a long message whole.
 */
const maxLoggedMessage = 300;

/**
 * What a save says of pages checked against stand-ins for the references
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
  env: Env
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
 * Builds a saved version's pages into the build cache (pages.ts), so
 * the version opens without building. Answers once done with how it
 * went, for whoever saved (an agent repairs what failed); none takes
 * longer than the build wait (`buildWaitMs` in pages.ts). Never throws: a
 * build is never a reason for a save to fail.
 */
export const buildOnSave = async (
  env: Env,
  source: SavedSource,
  {
    profile,
    checks = true,
    inspection,
  }: {
    /** `preview` for the App's draft, `production` for a saved version. */
    readonly profile: BuildProfile;
    /** False for a draft's write: its pages without the type check (pages.ts). */
    readonly checks?: boolean;
    /**
     * The inspection of its server code the references its pages import
     * are generated from (`inspectDraft`), when its caller shares one with
     * the server check: its own otherwise.
     */
    readonly inspection?: () => Promise<DraftInspection>;
  }
): Promise<SavedBuilds> => {
  const { files } = source;
  const options = { profile, checks };
  const pages = await savedBuild(
    "pages",
    source,
    buildFiles,
    // With the references its pages import, generated from these
    // files themselves: neither a save nor a draft is sealed yet.
    async () => {
      const { files: withReferences, standIn } = await withDraftReferences(
        env,
        source.app,
        files,
        options,
        inspection
      );
      const built = await buildPages(env, withReferences, source.app, options);
      return standIn ? { ...built, standIn: true as const } : built;
    },
    env
  );
  return { pages };
};

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
 * as a save inspects it for its pages (`filesManifest`). What the App
 * binds changes no type: only the seal's `contracts.json` records a
 * binding's pin. So what a check passes,
 * the seal's type check passes too. `inspection` is the one its pages'
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
  { app, files }: Pick<SavedSource, "app" | "files">,
  inspection: () => Promise<DraftInspection>
): Promise<{ ok: boolean; diagnostics?: Diagnostic[] }> => {
  // Whatever the draft holds under `.grasp/` is the host's to generate.
  const code = Object.fromEntries(
    Object.entries(files).filter(([path]) => !isGeneratedPath(path))
  );
  const options = { profile: "preview" } as const;
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
  const functions = serverFunctionsIn(code);
  const generated = await generateModules(manifest, functions);
  const checked = await checkAppCode(
    env,
    { ...code, ...generated },
    app,
    options
  );
  // What a seal refuses (app-releases.ts, `requireDeclaredFunctions`),
  // the check says first, by name.
  const undeclared = undeclaredFunctions(manifest, functions).map(
    (path): Diagnostic => ({
      file: `server/${path.split(".").slice(0, -1).join("/")}.ts`,
      rule: "server",
      severity: "error",
      message: `\`${path}\` isn't declared as its code registers it: declare it as \`export const ${path.split(".").at(-1) ?? path} = query({ … })\`, with the builder of its kind and visibility from @server/_generated/server called by name, never an alias of one or a wrapper, in a file that parses. Its App can't be published until it is.`,
    })
  );
  return undeclared.length === 0
    ? checked
    : {
        ok: false,
        diagnostics: [
          ...undeclared,
          ...(checked.ok ? [] : checked.diagnostics),
        ],
      };
};

/**
 * A draft's server code (`grasp.config.ts`, `values.ts`,
 * `server/`), checked as a check reports it: type
 * errors and every gate a seal holds it to, against the references its
 * seal would generate (`checkedDraftCode`); its registration runs in the
 * sandbox to say what they are, none of its functions (server code with
 * no app.ts and schema.ts fails there, saying so); `none` when it has
 * no server code. Never throws, as
 * `buildOnSave`. `inspection` is the one its caller shares with the
 * pages' build (`inspectDraft`), its own otherwise.
 */
export const draftServerBuild = async (
  env: Env,
  source: Pick<SavedSource, "app" | "version" | "files">,
  inspection: () => Promise<DraftInspection> = async () =>
    await inspectDraft(env, source.app, source.files, { profile: "preview" })
): Promise<SavedBuild> =>
  await savedBuild(
    "server",
    source,
    appCodeFiles,
    async () => await checkedDraftCode(env, source, inspection),
    env
  );

/**
 * The files Ultracite's rules read (`lint`): the App's TypeScript, but its
 * declarations, what core generates, and the config and schema its
 * definition generates (app-definition.ts), which no one edits.
 */
const lintedFiles = (files: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files).filter(
      ([path]) =>
        isLintedCode(path) &&
        !isGeneratedPath(path) &&
        !generatedPaths.has(path)
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
 * What a file whose lint stopped at the isolate's bounds by itself, in a
 * fresh isolate too (`run`'s `once`), says: an error, so a draft never
 * passes unlinted. Never kept: a later lint tries it again.
 */
const unlinted = (file: string): Diagnostic => ({
  file,
  rule: "lint",
  severity: "error",
  message:
    "Ultracite's lint stopped at its isolate's limits on this file alone: split it into smaller files.",
});

/**
 * What Ultracite's rules say of a draft's TypeScript (Ultracite's
 * `lint`): a build of its own, in an isolate of its own, so it runs beside
 * the others rather than after them. Each file's result is kept under the
 * key of its content (build-cache.ts), so a check lints only the files
 * that changed. The files it lacks go a batch at a time (`ultraciteBatch`),
 * each batch's results kept as it answers, so a lint stopped part way
 * resumes where it stopped; a batch stopped at a bound is split
 * (`callSplitting`). Failed while any of its errors is left; its warnings
 * stay warnings. Never throws, as `buildOnSave`.
 */
export const draftLintBuild = async (
  env: Env,
  source: Pick<SavedSource, "app" | "version" | "files">
): Promise<SavedBuild> => {
  const built = await savedBuild(
    "lint",
    source,
    lintedFiles,
    async () => {
      const files = lintedFiles(source.files);
      const kept = await readLints(env, files);
      const missing = Object.fromEntries(
        Object.entries(files).filter(([path]) => !Object.hasOwn(kept, path))
      );
      const linted: Record<string, Diagnostic[]> = {};
      const runner = platformRunner(env, source.app);
      for (const batch of batchesOf(Object.entries(missing), ultraciteBatch)) {
        // oxlint-disable-next-line no-await-in-loop -- one call at a time, each within its bounds
        const stopped = await callSplitting(batch, async (part) => {
          const found = lintedSchema.parse(
            await runner.run("ultracite", "lint", [part], { once: true })
          );
          await keepLints(env, part, found);
          Object.assign(linted, found);
        });
        // A stop of the load's (a deadline, a crash) is thrown, not split:
        // this lint couldn't run, and a later one tries it again.
        for (const file of stopped) {
          linted[file] = [unlinted(file)];
        }
      }
      const diagnostics = Object.keys(files)
        .toSorted()
        .flatMap((path) => kept[path] ?? linted[path] ?? []);
      return {
        ok: diagnostics.every(({ severity }) => severity !== "error"),
        diagnostics,
      };
    },
    env
  );
  return {
    ...built,
    diagnostics: built.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      category: isDesignRule(diagnostic.rule ?? "")
        ? ("design-system" as const)
        : ("code" as const),
    })),
  };
};
