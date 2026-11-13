import { ownFiles } from "@grasp-os/runtime/host";
import type { AppReview, DraftProblem } from "@grasp-os/shared/app-review";
import { appErrors } from "@grasp-os/shared/apps";
import type {
  DataModelChange,
  DraftDataModel,
  IndexUse,
} from "@grasp-os/shared/data-model";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";

import {
  checkFiles,
  defineInDraft,
  draftDefinitions,
  saveDraftChanges,
} from "./agent-builds.ts";
import type { DraftCheck } from "./agent-builds.ts";
import {
  dataModelOf,
  definitionPlan,
  operationDetail,
  usesOf,
} from "./app-definition.ts";
import {
  appFor,
  appKind,
  diffFiles,
  editableApp,
  nextLabel,
  versionFiles,
} from "./apps.ts";
import { draftOf, filesOf } from "./drafts.ts";
import { buildAppCode, buildPages } from "./pages.ts";
import { reviewDraft } from "./version-review.ts";

// What is App-only about an App's draft, for its builders (`apps.review`,
// `apps.dataModel`, `apps.define`, apps-rpc.ts): what publishing it would
// change, worked out by core from the draft as it is now, never taken
// from whoever wrote it; its data model; and a change of its definition
// by the person themselves, as a chat's agent's definition tools make
// one. Each checks the person builds the App.

/** Most problems a draft's review lists (`AppReview.check`). */
const maxProblems = 50;

/**
 * The errors `check` found, as a builder reads them before publishing:
 * its builds' errors by file, then what its preview ran into. Warnings
 * never fail a check, so they aren't listed.
 */
const problemsOf = (check: DraftCheck): DraftProblem[] =>
  [
    ...[check.pages, check.server, check.lint].flatMap((build) =>
      build.diagnostics
        .filter(({ severity }) => severity === "error")
        .map(({ file, line, message }) => ({ at: file, line, message }))
    ),
    ...check.preview.problems
      .filter(({ kind }) => kind !== "warning")
      .map(({ at, message }) => ({ at, line: null, message })),
  ].slice(0, maxProblems);

/**
 * What publishing App `app`'s draft would change against its live
 * version, for `by`, who builds it: its files, what it does to the App's
 * records, the access the App holds and asks for, and its check, as
 * publishing checks it (`checkFiles`). All read at the draft's revision
 * now, which the person publishes over.
 */
export const reviewChanges = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<AppReview> => {
  const found = await appFor(env, by, app, "builder");
  const { id, currentVersion } = found;
  const draft = await draftOf(env, appKind, id);
  const files = await filesOf(env, appKind, id, draft);
  const live = new Map(
    currentVersion === null
      ? []
      : Object.entries(await versionFiles(env, id, currentVersion))
  );
  const [review, check, next] = await Promise.all([
    reviewDraft(env, by, found, draft),
    checkFiles(env, id, draft, Object.fromEntries(files)),
    nextLabel(env, id, new Date()),
  ]);
  return {
    ...review,
    revision: draft.revision,
    live: currentVersion,
    liveLabel: found.liveLabel,
    next,
    files: diffFiles(live, files),
    check: { passed: check.passed, problems: problemsOf(check) },
  };
};

/**
 * What uses each of the draft's indexes, from what the compiler found
 * building its server code and its pages (cached by their files, as the
 * preview and the draft's check build them): none where a build fails,
 * or can't run now, which the data model is shown without.
 */
const indexUses = async (
  env: Env,
  app: string,
  files: ReadonlyMap<string, string>
): Promise<IndexUse[]> => {
  // Never their copy of what Grasp generates, as the preview builds them.
  const given = ownFiles(Object.fromEntries(files));
  try {
    const [code, pages] = await Promise.all([
      buildAppCode(env, given, app),
      // Compiled for what each page calls, not type-checked: a page that
      // calls a function reads as calling it whether or not it builds.
      buildPages(env, given, app, { profile: "preview", checks: false }),
    ]);
    return usesOf(code.ok ? (code.indexReads ?? []) : [], pages.calls ?? {});
  } catch (error) {
    log.warn("data_model.index_uses_failed", { app, ...errorFields(error) });
    return [];
  }
};

/**
 * The data model of App `app`'s draft (its definition), and what
 * publishing it does to the App's records, for `by`, who builds it.
 */
export const draftDataModel = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<DraftDataModel> => {
  const found = await appFor(env, by, app, "builder");
  const held = await draftDefinitions(env, found);
  if ("problem" in held) {
    throw appErrors.create("app.definition_invalid", {
      issues: [held.problem],
    });
  }
  return {
    model: dataModelOf(held.own),
    plan: definitionPlan(held.before, held.own),
    uses: await indexUses(env, found.id, held.files),
  };
};

/**
 * Changes the definition in App `app`'s draft by `operation`, by `by`
 * themselves, as a chat's agent's definition tools do (agent-builds.ts,
 * `defineInDraft`), audited as theirs: only while they build the App and
 * it isn't archived. With `preview`, saves nothing: what it would make of
 * the model, and the plan, to show before it is made.
 */
export const defineDraft = async (
  env: Env,
  by: Identity,
  app: unknown,
  operation: unknown,
  preview = false
): Promise<DataModelChange> => {
  const found = await editableApp(env, by, app);
  const defined = await defineInDraft(
    env,
    by,
    found,
    operation,
    async (draft, files, changes, definition) => {
      if (!preview) {
        await saveDraftChanges(
          env,
          { by, detail: operationDetail(operation) },
          found,
          { draft, files, changes, definition }
        );
      }
    }
  );
  return defined.ok
    ? {
        ok: true,
        model: dataModelOf(defined.definition),
        plan: defined.plan,
        change: defined.change,
      }
    : defined;
};
