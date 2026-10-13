import { failureText } from "@grasp-os/shared/errors";
import { roleErrors } from "@grasp-os/shared/roles";
import { dataErrors, migrationErrors } from "@grasp-os/shared/stores";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

// What the page says when a store's schema change gets in the way: when an
// admin abandons a failed one (store-changes.tsx), and when a builder makes
// a version current that the change holds back (chat/builds.tsx). Core's
// own messages are English and written for the API; these are the page's,
// in every locale, and say what to do next.

/** What the page says for each way core refuses an abandonment. */
const abandonRefusals: Readonly<Record<string, MessageDescriptor>> = {
  "migration.superseded": msg`A retry of this change already started, so it wasn't abandoned. The page shows where it stands now.`,
  "migration.not_failed": msg`This change is being applied again, so it can't be abandoned now. The page shows where it stands now.`,
  "migration.abandoned": msg`This change was already abandoned.`,
  "data.store_unavailable": msg`This store no longer exists, so there is nothing to abandon.`,
  "role.forbidden": msg`Only your organization's admins can abandon a change to a store.`,
};

/** Why abandoning a store's failed change didn't go through. */
export const abandonFailureText = (error: unknown): string => {
  const code =
    migrationErrors.codeOf(error) ??
    dataErrors.codeOf(error) ??
    roleErrors.codeOf(error);
  const refusal = code === undefined ? undefined : abandonRefusals[code];
  return refusal === undefined ? failureText(error) : i18n._(refusal);
};

/**
 * Why a version couldn't be made current, and whether a store's failed
 * change is what holds it back (`blocked`), which an admin sees, and can
 * abandon, on the engine's page.
 */
export const makeCurrentFailure = (
  error: unknown
): { text: string; blocked: boolean } => {
  const code = migrationErrors.codeOf(error);
  if (code === "migration.backfill_failed") {
    return {
      text: i18n._(
        msg`This version changes the engine's data, and the change can't be applied: a record already holds a value one of its new fields doesn't accept.`
      ),
      blocked: true,
    };
  }
  if (code === "migration.abandoned") {
    return {
      text: i18n._(
        msg`An admin abandoned the data change this version needs, so it can never be made current. Ask the engine to be built again.`
      ),
      blocked: false,
    };
  }
  if (code === "migration.pending") {
    return {
      text: i18n._(
        msg`This version's data change is still being applied. Try again in a moment.`
      ),
      blocked: false,
    };
  }
  return { text: failureText(error), blocked: false };
};
