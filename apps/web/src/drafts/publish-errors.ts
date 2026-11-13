import { failureText } from "@grasp-os/shared/errors";
import { draftSealFailures } from "@grasp-os/shared/functions";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { formatList } from "../format.ts";

// What the page says when core refuses to publish the draft of an App or
// a workflow (share-with-team.tsx) or to go back to an earlier version
// (draft-history.tsx, Undo in share-with-team.tsx). Core's own messages
// are English and written for the API; these are the page's, in every
// locale, and say what to do next. A refusal the page doesn't know keeps
// core's words.

/** The code of a refusal from core, if it has one. */
const codeOf = (error: unknown): string | undefined => {
  const code: unknown =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : undefined;
  return typeof code === "string" ? code : undefined;
};

/** What `error` holds in its details under `key`. */
const detailOf = (error: unknown, key: string): unknown => {
  const details: unknown =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "details")
      : undefined;
  return typeof details === "object" && details !== null
    ? Reflect.get(details, key)
    : undefined;
};

/** What the page says for each refusal of a publish it knows. */
const refusals: Readonly<Record<string, MessageDescriptor>> = {
  "draft.conflict": msg`Someone changed it since you opened this. Look at the changes again, then share.`,
  "draft.empty": msg`There are no changes to share.`,
  "app.draft_failed": msg`It doesn't pass its checks. Fix the problems, then share.`,
  "workflow.definition_invalid": msg`It doesn't pass its checks. Fix the problems, then share.`,
  "app.publish_busy": msg`Someone else is sharing this App right now. Try again in a moment.`,
  "app.archived": msg`This App is archived. Restore it to share it.`,
  "page.build_failed": msg`The App's pages don't build. Fix the problems, then share.`,
  "version.tests_failed": msg`The App's tests fail, so nothing was shared. Fix them, then share.`,
  "version.tests_unavailable": msg`The App's tests can't run on this deployment, so nothing was shared.`,
  "version.revoked": msg`An admin revoked this version, so it can't be shared again.`,
  "version.store_bound_elsewhere": msg`The App's data is bound to another App, so nothing was shared.`,
  "migration.required": msg`This changes the App's data in a way that needs a migration in code. Ask Grasp to write one, then share.`,
  "migration.pending": msg`The App's data is still being changed for an earlier version. Try again in a moment.`,
  "migration.busy": msg`The App's data kept changing while this was shared. Try again in a moment.`,
  "migration.abandoned": msg`An admin abandoned the data change this version needs, so it can't be shared. Ask Grasp to build the change again.`,
  "migration.backfill_failed": msg`The change to the App's data can't be applied: a record already holds a value a new field doesn't accept. An admin can see the record in the App's settings.`,
  "migration.invalid": msg`The App's migrations don't fit its data. Ask Grasp to fix them, then share.`,
  "version.invalid_migration": msg`The App's migrations don't fit its data. Ask Grasp to fix them, then share.`,
};

/** What the page says of a version whose migration failed on its fixtures. */
const fixturesFailedText = (error: unknown): string => {
  const named = detailOf(error, "migration");
  const migration = typeof named === "string" ? named : "";
  return i18n._(
    msg`The migration ${migration} failed on its fixtures, so nothing was shared. Ask Grasp to fix the migration or its fixtures, then share.`
  );
};

/** What the page says of a roll back a data migration rules out. */
const rollbackIncompatibleText = (error: unknown): string => {
  // Named by their labels, as people know versions; core gives those.
  const named = detailOf(error, "labels");
  const labels = Array.isArray(named)
    ? named.filter((label): label is string => typeof label === "string")
    : [];
  if (labels.length === 0) {
    return i18n._(
      msg`A data migration moved this App's records on since this version, so it can't be shared again. Share a new version instead.`
    );
  }
  const versions = formatList(labels);
  return i18n._(
    msg`A data migration moved this App's records on since this version, so it can't be shared again. Versions that still fit them: ${versions}.`
  );
};

/** Why publishing (or rolling back) didn't go through, as the page says it. */
export const publishFailureText = (error: unknown): string => {
  const code = codeOf(error);
  if (code === "version.migration_fixtures_failed") {
    return fixturesFailedText(error);
  }
  if (code === "migration.rollback_incompatible") {
    return rollbackIncompatibleText(error);
  }
  if (code !== undefined && draftSealFailures.has(code)) {
    return i18n._(
      msg`The App's server code doesn't build. Fix the problems, then share.`
    );
  }
  const known = code === undefined ? undefined : refusals[code];
  return known === undefined ? failureText(error) : i18n._(known);
};

/** Whether core refused because the draft moved since it was read. */
export const isConflict = (error: unknown): boolean =>
  codeOf(error) === "draft.conflict";

/** How a change against core went: its answer, or why it didn't go through. */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Runs `action` on the signed-in person's session over `core`, with no
 * time limit of a page's read (a publish checks and builds the draft):
 * its answer, or core's refusal, for the page to say in its own words.
 * Outside components, as the React Compiler can't compile `try`.
 */
export const settled = async <T>(
  core: Pick<CoreConnection, "withSession">,
  action: (session: Session) => Promise<T>
): Promise<Settled<T>> => {
  try {
    return { ok: true, value: await core.withSession(action) };
  } catch (error) {
    return { ok: false, error };
  }
};
