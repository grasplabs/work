import { versionErrors } from "@grasp-os/shared/app-releases";
import { failureText } from "@grasp-os/shared/errors";
import { roleErrors } from "@grasp-os/shared/roles";
import { dataErrors, migrationErrors } from "@grasp-os/shared/stores";
import { workflowErrors } from "@grasp-os/shared/workflows";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { formatList } from "../format.ts";

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
): "invalid_value" | "too_large" | "migration" | "stalled" => {
  if (typeof error !== "object" || error === null || !("details" in error)) {
    return "stalled";
  }
  const { details } = error;
  if (typeof details !== "object" || details === null) {
    return "stalled";
  }
  const failure = "failure" in details ? details.failure : null;
  if (
    typeof failure === "object" &&
    failure !== null &&
    "migration" in failure
  ) {
    return "migration";
  }
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
  invalid_value: msg`This version changes the domain's data, and the change can't be applied: a record already holds a value one of its new fields doesn't accept.`,
  too_large: msg`This version changes the domain's data, and the change can't be applied: filling in one of its new fields would make a record larger than a record may be.`,
  migration: msg`This version changes the domain's data with a migration, and it can't finish: its transform failed, or answered what the table doesn't accept.`,
  stalled: msg`This version changes the domain's data, and the change can't be applied: filling in its new fields stopped making progress.`,
} as const;

/** Where the engine's page helps, by the failure's reason. */
const backfillFailedLinks = {
  invalid_value: msg`An admin can see the record that holds it back, and abandon the change, on the domain's page.`,
  too_large: msg`An admin can see the record that holds it back, and abandon the change, on the domain's page.`,
  migration: msg`An admin can see what went wrong, and abandon the change, on the domain's page.`,
  stalled: msg`No record is to blame, so an admin can only abandon the change, on the domain's page.`,
} as const;

/**
 * The versions a refused rollback names as still fitting the store
 * (`migration.rollback_incompatible`'s `details.compatible`), newest
 * first; none when core named none or sent something else.
 */
const compatibleOf = (error: unknown): number[] => {
  if (typeof error !== "object" || error === null || !("details" in error)) {
    return [];
  }
  const { details } = error;
  const compatible =
    typeof details === "object" && details !== null && "compatible" in details
      ? details.compatible
      : undefined;
  return Array.isArray(compatible)
    ? compatible.filter(
        (version): version is number =>
          typeof version === "number" && Number.isInteger(version)
      )
    : [];
};

/** Why a migration's fixture failed, by core's reason, as the page says it. */
const fixtureReasons: Readonly<Record<string, MessageDescriptor>> = {
  invalid_input: msg`the fixture's row doesn't fit what the migration takes`,
  threw: msg`the migration threw an error`,
  invalid_output: msg`its output doesn't fit the table`,
  too_large: msg`its output is larger than a record may be`,
  invalid_answer: msg`it answered something that isn't its records`,
  unexpected_output: msg`its output isn't what the fixture expects`,
};

/** A string of `details` under `key`, when it is one. */
const detailOf = (error: unknown, key: string): unknown => {
  if (typeof error !== "object" || error === null || !("details" in error)) {
    return undefined;
  }
  const { details } = error;
  return typeof details === "object" && details !== null && key in details
    ? Reflect.get(details, key)
    : undefined;
};

/** What the page says of a migration that failed on its fixtures. */
const fixturesFailedText = (error: unknown): string => {
  const named = detailOf(error, "migration");
  const migration = typeof named === "string" ? named : "";
  const fixture = detailOf(error, "fixture");
  const reasonCode = detailOf(error, "reason");
  const known =
    typeof reasonCode === "string" && Object.hasOwn(fixtureReasons, reasonCode)
      ? fixtureReasons[reasonCode]
      : undefined;
  const reason =
    known === undefined ? i18n._(msg`it didn't pass`) : i18n._(known);
  if (typeof fixture === "number") {
    return i18n._(
      msg`The migration ${migration} failed on its fixture ${fixture} when this version was sealed: ${reason}. It runs on no records, so the version can't be made current: fix the migration or its fixture and build the domain again.`
    );
  }
  return i18n._(
    msg`The migration ${migration} failed on its fixtures when this version was sealed: ${reason}. It runs on no records, so the version can't be made current: fix the migration or its fixtures and build the domain again.`
  );
};

/** What the page says of a rollback a data migration rules out. */
const rollbackIncompatibleText = (error: unknown): string => {
  const compatible = compatibleOf(error);
  if (compatible.length === 0) {
    return i18n._(
      msg`A data migration moved this domain's records on after this version, so it can't be made current again, and no kept version fits them now. Build a new version instead.`
    );
  }
  const versions = formatList(compatible.map(String));
  return i18n._(
    msg`A data migration moved this domain's records on after this version, so it can't be made current again. Kept versions that still fit them: ${versions}.`
  );
};

/** One AI step `workflow.model_undeclared` names, as core sends it. */
const isStepRefusal = (
  value: unknown
): value is { file: string; line: number; message: string } =>
  typeof value === "object" &&
  value !== null &&
  "file" in value &&
  typeof value.file === "string" &&
  "line" in value &&
  typeof value.line === "number" &&
  "message" in value &&
  typeof value.message === "string";

/**
 * Why a version couldn't be made current and, when a store's failed
 * change holds it back, what to say of the engine's page (`link`), where an
 * admin sees it and can abandon it.
 */
export const makeCurrentFailure = (
  error: unknown
): {
  text: string;
  link: string | undefined;
  /**
   * What core said went wrong, in its own words, when that helps mend it:
   * a fixture's thrown message, or what it answered against what was
   * expected. Fixtures are the App's own data, never real records.
   */
  issues?: readonly string[];
} => {
  if (versionErrors.codeOf(error) === "version.migration_fixtures_failed") {
    const issues = detailOf(error, "issues");
    return {
      text: fixturesFailedText(error),
      link: undefined,
      issues: Array.isArray(issues)
        ? issues
            .filter((issue): issue is string => typeof issue === "string")
            .slice(0, 20)
        : [],
    };
  }
  if (workflowErrors.codeOf(error) === "workflow.model_undeclared") {
    const diagnostics = detailOf(error, "diagnostics");
    return {
      text: failureText(error),
      link: undefined,
      // Each AI step core refused, at its file and line, and why.
      issues: Array.isArray(diagnostics)
        ? diagnostics
            .flatMap((diagnostic: unknown) =>
              isStepRefusal(diagnostic)
                ? [
                    `${diagnostic.file}:${diagnostic.line}: ${diagnostic.message}`,
                  ]
                : []
            )
            .slice(0, 20)
        : [],
    };
  }
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
        msg`An admin abandoned the data change this version needs, so it can never be made current. Ask the domain to be built again.`
      ),
      link: undefined,
    };
  }
  if (code === "migration.rollback_incompatible") {
    return { text: rollbackIncompatibleText(error), link: undefined };
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
