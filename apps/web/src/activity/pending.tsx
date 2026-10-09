import { appErrors } from "@grasp-os/shared/apps";
import type { AppExports } from "@grasp-os/shared/apps";
import type { Permission } from "@grasp-os/shared/permissions";
import { i18n } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";

import type { Session } from "../core.ts";
import {
  appName,
  appsById,
  formatTime,
  personName,
  readPeople,
} from "../directory.ts";
import type { Directory } from "../directory.ts";
import { formatList } from "../format.ts";

// Pending approvals: the permissions Apps and agents asked for, which an
// admin grants or rejects on the dashboard's pile (`dashboard/pile-cards.tsx`).
// Core checks the role on every call; the dashboard reads them only for
// those core lets decide (the organization's own admins, never Grasp staff).

/** The requests an admin decides, oldest first, with the names to show. */
export interface PendingRequests {
  requests: Permission[];
  directory: Directory;
  /**
   * The exports of each App a request asks to call, as they are now: what
   * granting it lets the asking App call. Missing for one that couldn't
   * be read.
   */
  exports: ReadonlyMap<string, AppExports>;
}

/**
 * Every request waiting for an admin, oldest first as core lists them. The
 * Apps are read in full, not only for names: they say which version an
 * admin reviews, so the tab fails without them rather than offer the
 * wrong decisions.
 */
export const readPendingRequests = async (
  session: Session
): Promise<PendingRequests> => {
  const [requests, apps, people] = await Promise.all([
    session.permissions.list(undefined, "requested"),
    session.apps.list(),
    readPeople(session),
  ]);
  const directory = { people, apps: appsById(apps) };
  const called = [
    ...new Set(
      requests.flatMap(({ object }) =>
        object.type === "app" ? [object.appId] : []
      )
    ),
  ];
  // Each App's exports on their own: one that can't be read is shown as
  // such, and the requests are still there to decide.
  const read = await Promise.allSettled(
    called.map(async (app) => await session.apps.exports(app))
  );
  const exports = new Map<string, AppExports>();
  for (const [index, app] of called.entries()) {
    const result = read[index];
    if (result?.status === "fulfilled") {
      exports.set(app, result.value.exports);
    }
  }
  return { requests, directory, exports };
};

/** Who asks: the App or agent the permission is for. */
export const subjectOf = (
  { subject }: Permission,
  directory: Directory
): string =>
  subject.type === "app"
    ? appName(directory, subject.appId)
    : i18n._(msg`Agent ${ph({ agent: subject.agentId })}`);

/**
 * The exports of another App a request's actions cover, as they are now:
 * all those marked `read` or `write`, and each named.
 */
const coveredExports = (
  actions: readonly string[],
  exported: AppExports | undefined
): string => {
  if (exported === undefined) {
    return i18n._(msg`couldn't be read`);
  }
  const covered = Object.entries(exported).flatMap(([name, { access }]) =>
    actions.includes(name) || actions.includes(access)
      ? [`${name} (${access})`]
      : []
  );
  return covered.length === 0 ? i18n._(msg`none now`) : formatList(covered);
};

/** What it asks for, by ID: connections and collections have no names here. */
export const objectOf = (
  { object, actions }: Permission,
  directory: Directory,
  exports: PendingRequests["exports"]
): string => {
  if (object.type === "connection") {
    const { connectionId, resource } = object;
    return resource === undefined
      ? i18n._(msg`Connection ${connectionId}`)
      : i18n._(msg`Connection ${connectionId}, ${resource}`);
  }
  if (object.type === "collection") {
    const { collectionId } = object;
    return i18n._(msg`Collection ${collectionId}`);
  }
  if (object.type === "app") {
    const engine = appName(directory, object.appId);
    const covered = coveredExports(actions, exports.get(object.appId));
    return i18n._(msg`Exports of ${ph({ domain: engine })}: ${covered}`);
  }
  if (object.type === "platform" && actions.includes("guests")) {
    // Consent in plain words: who reaches what, and at whose cost.
    return i18n._(
      msg`Guest chats. This domain can invite people who aren't members to a short chat with a model through a link, and read back what they write. Guests reach nothing else; their chats spend the model budget of whoever invites them`
    );
  }
  if (object.type === "platform") {
    // Consent in plain words: what the App reads is published company-wide
    // on purpose (counts only, never a run), and it may show it to anyone.
    return i18n._(
      msg`Platform statistics. This domain can read run and signal counts for every domain, and may show them to anyone who uses it`
    );
  }
  const { workflowId } = object;
  const engine = appName(directory, object.appId);
  return i18n._(msg`Workflow ${workflowId} of ${ph({ domain: engine })}`);
};

/**
 * The record types a request to write a collection would claim there, and
 * those another App keeps there already, which this App wouldn't get:
 * named, for an admin to grant the one they want.
 */
export const RecordTypeClaims = ({
  request,
  directory,
}: {
  request: Permission;
  directory: Directory;
}) => {
  const { recordTypes } = request;
  const { t } = useLingui();
  if (recordTypes === undefined) {
    return null;
  }
  const claimed = formatList(recordTypes.claims);
  return (
    <>
      {recordTypes.claims.length === 0 ? null : (
        <span className="text-muted-foreground block text-xs">
          <Trans>Would keep {claimed} records here</Trans>
        </span>
      )}
      {recordTypes.taken.map(({ type, owner }) => (
        <span key={type} className="text-destructive block text-xs">
          {owner === null
            ? t`Another domain already keeps ${type} records here: this domain's won't apply.`
            : t`${ph({ domain: appName(directory, owner) })} already keeps ${type} records here: this domain's won't apply.`}
        </span>
      ))}
    </>
  );
};

/**
 * The version of the App an admin reviews as they decide: the one current
 * as the list was read, whose code the grant trusts. Null for an agent's
 * permission, an App with none current, or one the list doesn't have:
 * core then grants only if the App still has none current.
 */
export const reviewedVersion = (
  { subject }: Permission,
  directory: Directory
): number | null =>
  subject.type === "app"
    ? (directory.apps.get(subject.appId)?.currentVersion ?? null)
    : null;

/** The version to review, as the row shows it. */
export const reviewedVersionText = (
  request: Permission,
  directory: Directory
): string => {
  const { subject } = request;
  if (subject.type !== "app") {
    return "–";
  }
  if (!directory.apps.has(subject.appId)) {
    return i18n._(msg`Unknown`);
  }
  const version = reviewedVersion(request, directory);
  return version === null ? i18n._(msg`None current`) : String(version);
};

/**
 * Why a request is asked for again, if it is: it was granted before, and
 * making another version of its App current asked for it again.
 */
export const askedAgain = (
  request: Permission,
  directory: Directory
): string | undefined => {
  const { grantedBy, grantedAt } = request;
  if (grantedBy === null || grantedAt === null) {
    return undefined;
  }
  const version = reviewedVersion(request, directory);
  const person = personName(directory, grantedBy);
  const date = formatTime(grantedAt);
  return version === null
    ? i18n._(msg`Asked again (previously granted by ${person} on ${date})`)
    : i18n._(
        msg`Asked again after version ${version} was made current (previously granted by ${person} on ${date})`
      );
};

const versionChanged = msg`Another version of this domain was made current since this list was read. The list now shows it: review that version, then approve again.`;

/**
 * Grants `request` for `version`, the one the admin reviewed. Core refuses
 * with `app.conflict` once another version is current: that is said
 * plainly. Outside components, as the React Compiler can't compile `try`.
 */
export const grantReviewed = async (
  permissions: Session["permissions"],
  request: Permission,
  version: number | null
): Promise<Permission> => {
  try {
    return await permissions.grant(request.id, { version });
  } catch (error) {
    if (appErrors.codeOf(error) === "app.conflict") {
      throw new Error(i18n._(versionChanged), { cause: error });
    }
    throw error;
  }
};
