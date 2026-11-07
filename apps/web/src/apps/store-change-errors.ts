import { versionErrors } from "@grasp-os/shared/app-releases";
import { failureText } from "@grasp-os/shared/errors";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

// What the page says when a builder makes a version current and core
// refuses (chat/builds.tsx): a migration that failed on its fixtures as the
// version was sealed is said in the page's words, in every locale; a
// schema change its store refuses, or a migration that failed on a record,
// as core says it, which names what to change.

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
      msg`The migration ${migration} failed on its fixture ${fixture} when this version was sealed: ${reason}. It runs on no records, so the version can't be made current: fix the migration or its fixture and build the App again.`
    );
  }
  return i18n._(
    msg`The migration ${migration} failed on its fixtures when this version was sealed: ${reason}. It runs on no records, so the version can't be made current: fix the migration or its fixtures and build the App again.`
  );
};

/**
 * Why a version couldn't be made current, and what core said went wrong,
 * in its own words, when that helps mend it: a fixture's thrown message,
 * or what it answered against what was expected. Fixtures are the App's
 * own data, never real records.
 */
export const makeCurrentFailure = (
  error: unknown
): { text: string; issues?: readonly string[] } => {
  if (versionErrors.codeOf(error) !== "version.migration_fixtures_failed") {
    return { text: failureText(error) };
  }
  const issues = detailOf(error, "issues");
  return {
    text: fixturesFailedText(error),
    issues: Array.isArray(issues)
      ? issues
          .filter((issue): issue is string => typeof issue === "string")
          .slice(0, 20)
      : [],
  };
};
