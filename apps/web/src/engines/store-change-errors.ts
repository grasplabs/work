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
 * Why a store's backfill failed, as core's `migration.backfill_failed`
 * says in its details: a record's value the field doesn't accept, a record
 * the default would make too large, or runs that stopped moving (`stalled`,
 * and anything this page doesn't know), which name no record to mend.
 */
const failedReasonOf = (
  error: unknown
): "invalid_value" | "too_large" | "stalled" => {
  if (typeof error !== "object" || error === null || !("details" in error)) {
    return "stalled";
  }
  const { details } = error;
  if (typeof details !== "object" || details === null) {
    return "stalled";
  }
  const failure = "failure" in details ? details.failure : null;
  const reason =
    typeof failure === "object" && failure !== null && "reason" in failure
      ? failure.reason
      : undefined;
  return reason === "invalid_value" || reason === "too_large"
    ? reason
    : "stalled";
};

/** What makes a version wait on a store's failed change, by its reason. */
const backfillFailedTexts = {
  invalid_value: msg`This version changes the engine's data, and the change can't be applied: a record already holds a value one of its new fields doesn't accept.`,
  too_large: msg`This version changes the engine's data, and the change can't be applied: filling in one of its new fields would make a record larger than a record may be.`,
  stalled: msg`This version changes the engine's data, and the change can't be applied: filling in its new fields stopped making progress.`,
} as const;

/** Where the engine's page helps, by the failure's reason. */
const backfillFailedLinks = {
  invalid_value: msg`An admin can see the record that holds it back, and abandon the change, on the engine's page.`,
  too_large: msg`An admin can see the record that holds it back, and abandon the change, on the engine's page.`,
  stalled: msg`No record is to blame, so an admin can only abandon the change, on the engine's page.`,
} as const;

/**
 * Why a version couldn't be made current and, when a store's failed
 * change holds it back, what to say of the engine's page (`link`), where an
 * admin sees it and can abandon it.
 */
export const makeCurrentFailure = (
  error: unknown
): { text: string; link: string | undefined } => {
  const code = migrationErrors.codeOf(error);
  if (code === "migration.backfill_failed") {
    const reason = failedReasonOf(error);
    return {
      text: i18n._(backfillFailedTexts[reason]),
      link: i18n._(backfillFailedLinks[reason]),
    };
  }
  if (code === "migration.abandoned") {
    return {
      text: i18n._(
        msg`An admin abandoned the data change this version needs, so it can never be made current. Ask the engine to be built again.`
      ),
      link: undefined,
    };
  }
  if (code === "migration.pending") {
    return {
      text: i18n._(
        msg`This version's data change is still being applied. Try again in a moment.`
      ),
      link: undefined,
    };
  }
  return { text: failureText(error), link: undefined };
};
