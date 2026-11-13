import type { AppMemberRef, ShareCandidates } from "@grasp-os/shared/apps";
import type { Subject } from "@grasp-os/shared/subject";

import type { Session } from "../core.ts";

// Whom an App or a workflow is shared with, as Share with your team
// (share-with-team.tsx) reads and changes it: each kind through its own
// calls (`apps.members`, `workflowResources.members`), one shape here.
// Share with your team only adds people as users and takes them off
// again; roles are changed in the subject's own Sharing settings.

/** Someone it is shared with: a person, a team, or everyone in a project. */
export interface Member extends AppMemberRef {
  /** Their name; null once they are gone, or for a project the person isn't in. */
  name: string | null;
}

/**
 * Whom `subject` is shared with, by name: an App's members are named by
 * core; a workflow's people and teams by its share candidates.
 */
export const readMembers = async (
  session: Session,
  { kind, id }: Subject
): Promise<Member[]> => {
  if (kind === "app") {
    return await session.apps.members.list(id);
  }
  const [candidates, members] = await Promise.all([
    session.workflowResources.shareCandidates(id),
    session.workflowResources.members(id),
  ]);
  return members.map(({ type, id: member, projectName }) => {
    if (type === "project") {
      return { type, id: member, name: projectName ?? null };
    }
    const named = (
      type === "person" ? candidates.people : candidates.teams
    ).find((each) => each.id === member)?.name;
    return { type, id: member, name: named ?? null };
  });
};

/** Whom `subject` may be shared with: the organization's people, teams and projects. */
export const readCandidates = async (
  session: Session,
  { kind, id }: Subject
): Promise<ShareCandidates> =>
  kind === "app"
    ? await session.apps.members.candidates(id)
    : await session.workflowResources.shareCandidates(id);

/** Shares `subject` with `member`, as a user. */
export const addMember = async (
  session: Session,
  { kind, id }: Subject,
  { type, id: member }: AppMemberRef
): Promise<void> => {
  await (kind === "app"
    ? session.apps.members.add(id, { type, id: member, role: "user" })
    : session.workflowResources.share(id, { type, id: member, role: "user" }));
};

/** Stops sharing `subject` with `member`. */
export const removeMember = async (
  session: Session,
  { kind, id }: Subject,
  { type, id: member }: AppMemberRef
): Promise<void> => {
  await (kind === "app"
    ? session.apps.members.remove(id, { type, id: member })
    : session.workflowResources.unshare(id, { type, id: member }));
};

/**
 * Who uses it by name, as its status says it: the teams, people and
 * projects it is shared with, those with a name the person may read.
 */
export const memberNames = (members: readonly Member[]): string[] =>
  members.flatMap(({ name }) => (name === null ? [] : [name]));
