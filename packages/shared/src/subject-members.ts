import { z } from "zod";

import { identifierSchema } from "./ids.ts";

// Whom an App or a workflow (a subject, @grasp-os/shared/subject) is
// shared with (core's app-members.ts and workflow-resources.ts), alike for
// both kinds: `apps.members` and `workflowResources.members`. Not the
// organization's members (@grasp-os/shared/members). Each is private: open to its owner
// (always a builder, and not listed), to the organization's admins, who
// manage every one, and to the people, teams and projects it is shared
// with. Anyone with a role in it lists them; its builders change them,
// never Grasp staff.

/**
 * A role in one App or workflow: a `user` uses it; a `builder` also
 * changes it, publishes it and whom it is shared with. The person's role
 * in the organization is a ceiling: someone whose role there is `user`
 * never builds, whatever its members say.
 */
export const memberRoleSchema = z.enum(["user", "builder"]);
export type MemberRole = z.infer<typeof memberRoleSchema>;

/**
 * Whom it is shared with: a person or a team of the organization, or
 * everyone in a project (@grasp-os/shared/projects).
 */
export const subjectMemberRefSchema = z.strictObject({
  type: z.enum(["person", "team", "project"]),
  id: identifierSchema,
});
export type SubjectMemberRef = z.infer<typeof subjectMemberRefSchema>;

/** Sharing it with someone, or changing their role in it. */
export const newSubjectMemberSchema = z.strictObject({
  ...subjectMemberRefSchema.shape,
  role: memberRoleSchema,
});
export type NewSubjectMember = z.input<typeof newSubjectMemberSchema>;

/** Someone it is shared with. Times are ISO 8601. */
export interface SubjectMember extends SubjectMemberRef {
  /**
   * The person's, team's or project's name; null once they are gone, and
   * for a project the person isn't in, whose name is its members' alone.
   */
  name: string | null;
  role: MemberRole;
  /** Who shared it with them, or last changed their role. */
  addedBy: string;
  addedAt: string;
}

/**
 * The organization's people and teams, by name and ID alone, to share it
 * with, and the projects the person builds, whose everyone it may be
 * shared with.
 */
export interface ShareCandidates {
  people: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  projects: { id: string; name: string }[];
}

/** Whom an App or a workflow `id` is shared with. */
export interface SubjectMembersApi {
  list: (id: string) => Promise<SubjectMember[]>;
  /**
   * Shares it, or changes the role of someone it is shared with. An App
   * is refused with `app.share_unreadable`, naming the `sources` and
   * `people` in its details, when it has read data (from someone's
   * personal connection, or a collection they can't read) that anyone it
   * would reach can't read where it comes from.
   */
  add: (id: string, member: NewSubjectMember) => Promise<SubjectMember>;
  /**
   * Stops sharing it with them. Their open pages of it stop at once, or
   * within a few seconds, as every push checks their role again.
   */
  remove: (id: string, member: SubjectMemberRef) => Promise<void>;
  /**
   * Whom its builders may share it with (`ShareCandidates`): for whoever
   * may share it (`add`). No address, no role, no team's members.
   */
  candidates: (id: string) => Promise<ShareCandidates>;
}
