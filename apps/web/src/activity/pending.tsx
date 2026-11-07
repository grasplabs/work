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
import {
  kindLabels,
  triggerDescription,
} from "../workflows/trigger-description.ts";

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
 * The requests waiting for an admin (as the feed of what waits lists
 * them), with the names to show. The Apps are read in full, not only for
 * names: they say which version an admin reviews, so the tab fails
 * without them rather than offer the wrong decisions.
 */
export const readRequestNames = async (
  session: Session,
  requests: Permission[]
): Promise<PendingRequests> => {
  const [apps, people] = await Promise.all([
    session.apps.list(),
    readPeople(session),
  ]);
  return { requests, directory: { people, apps: appsById(apps) } };
};

/** Workflow `id`, by the name core gave it in `names`, else by its ID. */
const workflowNamed = (
  id: string,
  names: Permission["workflowNames"]
): string => i18n._(msg`Workflow ${ph({ workflow: names?.[id] ?? id })}`);

/**
 * What holds a permission other than an App, for people: the agent, or an
 * independent workflow (by its name in `names`, where core gave it), or a
 * trigger, by its ID.
 */
export const holderName = (
  subject: Exclude<PermissionSubject, { type: "app" }>,
  names?: Permission["workflowNames"]
): string => {
  switch (subject.type) {
    case "agent": {
      return i18n._(msg`Agent ${ph({ agent: subject.agentId })}`);
    }
    case "workflow": {
      return workflowNamed(subject.workflowId, names);
    }
    case "trigger": {
      return i18n._(msg`Trigger ${ph({ trigger: subject.triggerId })}`);
    }
    default: {
      return subject satisfies never;
    }
  }
};

/**
 * Who asks: the App, agent or independent resource the permission is for;
 * a trigger by its kind and what starts it, as core lists it.
 */
export const subjectOf = (
  { subject, trigger, workflowNames }: Permission,
  directory: Directory
): string => {
  if (subject.type === "app") {
    return appName(directory, subject.appId);
  }
  if (trigger === undefined) {
    return holderName(subject, workflowNames);
  }
  const kind = i18n._(kindLabels[trigger.kind]);
  const what = triggerDescription(trigger);
  return i18n._(msg`${kind} (${what})`);
};

/**
 * What it asks for: a workflow by its name, connections and collections
 * by ID, as they have no names here.
 */
export const objectOf = (
  { object, actions, workflowNames }: Permission,
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
    // An agent's permission on an App's functions, by action as core
    // checks it (agent-apps.ts): `read` calls its queries, `write` its
    // mutations and actions, and neither allows the other's.
    const app = appName(directory, object.appId);
    const reads = actions.includes("read");
    const writes = actions.includes("write");
    if (reads && writes) {
      return i18n._(msg`Queries, mutations and actions of ${ph({ app })}`);
    }
    return writes
      ? i18n._(msg`Mutations and actions of ${ph({ app })}`)
      : i18n._(msg`Queries of ${ph({ app })}`);
  }
  if (object.type === "platform" && actions.includes("guests")) {
    // Consent in plain words: who reaches what, and at whose cost.
    return i18n._(
      msg`Guest chats. This App can invite people who aren't members to a short chat with a model through a link, and read back what they write. Guests reach nothing else; their chats spend the model budget of whoever invites them`
    );
  }
  if (object.type === "platform" && actions.includes("brain")) {
    // Consent in plain words: what it reads, and whose access bounds it.
    return i18n._(
      msg`Company Brain, read only. This can read company Brain evidence and its open questions, from the collections it was granted and only what the person it works for may read too. It can never write to the Brain. Every read is recorded`
    );
  }
  if (object.type === "platform") {
    // Consent in plain words: what the App reads is published company-wide
    // on purpose (counts only, never a run), and it may show it to anyone.
    return i18n._(
      msg`Platform statistics. This App can read run and signal counts for every App, and may show them to anyone who uses it`
    );
  }
  return workflowNamed(object.workflowId, workflowNames);
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

const versionChanged = msg`Another version of this App was made current since this list was read. The list now shows it: review that version, then approve again.`;

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
