import { appErrors } from "@grasp-os/shared/apps";
import type {
  Permission,
  PermissionSubject,
} from "@grasp-os/shared/permissions";
import { i18n } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";

import type { Session } from "../core.ts";
import {
  appName,
  appsById,
  formatTime,
  personName,
  readPeople,
} from "../directory.ts";
import type { Directory } from "../directory.ts";

// Pending approvals: the permissions Apps and agents asked for, which an
// admin grants or rejects on the dashboard's pile (`dashboard/pile-cards.tsx`).
// Core checks the role on every call; the dashboard reads them only for
// those core lets decide (the organization's own admins, never Grasp staff).

/** The requests an admin decides, oldest first, with the names to show. */
export interface PendingRequests {
  requests: Permission[];
  directory: Directory;
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
  return { requests, directory: { people, apps: appsById(apps) } };
};

/**
 * What holds a permission other than an App, for people: the agent, or an
 * independent workflow, store or trigger, by its ID.
 */
export const holderName = (
  subject: Exclude<PermissionSubject, { type: "app" }>
): string => {
  switch (subject.type) {
    case "agent": {
      return i18n._(msg`Agent ${ph({ agent: subject.agentId })}`);
    }
    case "workflow": {
      return i18n._(msg`Workflow ${ph({ workflow: subject.workflowId })}`);
    }
    case "store": {
      return i18n._(msg`Store ${ph({ store: subject.storeId })}`);
    }
    case "trigger": {
      return i18n._(msg`Trigger ${ph({ trigger: subject.triggerId })}`);
    }
    default: {
      return subject satisfies never;
    }
  }
};

/** Who asks: the App, agent or independent resource the permission is for. */
export const subjectOf = (
  { subject }: Permission,
  directory: Directory
): string =>
  subject.type === "app"
    ? appName(directory, subject.appId)
    : holderName(subject);

/** What it asks for, by ID: connections and collections have no names here. */
export const objectOf = (
  { object, actions }: Permission,
  directory: Directory
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
    // An agent's permission on an App's functions: those that read, or
    // all of them.
    const engine = appName(directory, object.appId);
    return actions.includes("write")
      ? i18n._(
          msg`Functions of ${ph({ domain: engine })}, reading and changing its data`
        )
      : i18n._(msg`Functions of ${ph({ domain: engine })}, reading its data`);
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
  if (object.type === "store") {
    return i18n._(msg`Store ${ph({ store: object.storeId })}`);
  }
  return i18n._(msg`Workflow ${ph({ workflow: object.workflowId })}`);
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
