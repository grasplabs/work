import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import { identifierSchema } from "./ids.ts";

// Projects: an optional grouping of Apps and workflows for a process
// ("Sell & get paid"), a team ("Finance") or a goal ("Q1 cash"), with a
// name, a description, an icon and whoever is in it. An App or workflow is
// in no project or in several; connections are never grouped, they belong
// to the Apps and workflows that use them. Deleting a project never
// deletes what is in it.
//
// Filing never shares: an item filed in a project reaches nobody new.
// Whom it reaches is its own sharing list, where a project is one row
// ("Everyone in Sell & get paid", as a user or a builder), added only when
// someone who builds the item and the project chooses to.

/** The icons a project may have, by name; the page draws each. */
export const projectIcons = [
  "folder",
  "briefcase",
  "target",
  "users",
  "coins",
  "rocket",
  "chart",
  "lightbulb",
  "wrench",
  "sparkles",
] as const;
export type ProjectIcon = (typeof projectIcons)[number];

/** Longest name a project has, in characters. */
export const projectNameMaxLength = 80;

/** Longest description a project has, in characters. */
export const projectDescriptionMaxLength = 500;

/** Most items one project holds, filed or shared with it. */
export const projectItemsMax = 200;

/** Most people and teams in one project besides its owner. */
export const projectMembersMax = 100;

/** A role in a project: `user` sees it; `builder` also changes it. */
export const projectRoleSchema = z.enum(["user", "builder"]);
export type ProjectRole = z.infer<typeof projectRoleSchema>;

/** A new project. */
export const newProjectSchema = z.strictObject({
  name: z.string().trim().min(1).max(projectNameMaxLength),
  description: z.string().trim().max(projectDescriptionMaxLength).default(""),
  icon: z.enum(projectIcons).default("folder"),
});
export type NewProject = z.input<typeof newProjectSchema>;

/** What a project's builder changes of it: at least one. */
export const projectChangesSchema = newProjectSchema
  .partial()
  .refine((changes) => Object.values(changes).some((v) => v !== undefined), {
    message: "Change at least one of its name, description or icon",
  });
export type ProjectChanges = z.input<typeof projectChangesSchema>;

/** Who is in a project: a person or a team of the organization. */
export const projectMemberRefSchema = z.strictObject({
  type: z.enum(["person", "team"]),
  id: identifierSchema,
});
export type ProjectMemberRef = z.infer<typeof projectMemberRefSchema>;

/** Adding someone to a project, or giving them another role in it. */
export const newProjectMemberSchema = z.strictObject({
  ...projectMemberRefSchema.shape,
  role: projectRoleSchema,
});
export type NewProjectMember = z.input<typeof newProjectMemberSchema>;

/** An App or an independent workflow, as a project holds it. */
export const projectItemRefSchema = z.strictObject({
  type: z.enum(["app", "workflow"]),
  id: identifierSchema,
});
export type ProjectItemRef = z.infer<typeof projectItemRefSchema>;

/**
 * Filing an item in a project. `share` also shares it with everyone in the
 * project, as users; off unless asked for, since filing never shares.
 */
export const fileItemSchema = z.strictObject({
  item: projectItemRefSchema,
  share: z.boolean().default(false),
});
export type FileItem = z.input<typeof fileItemSchema>;

/** What a project holds that the person may open, counted. */
export interface ProjectCounts {
  apps: number;
  workflows: number;
  /** The connections those Apps and workflows use, each once. */
  connections: number;
}

/**
 * A project as its card shows it. Its counts are of what the person may
 * open: what they weren't shared isn't counted, so a count never tells of
 * an item they can't see.
 */
export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  icon: ProjectIcon;
  /** The person's role in it. */
  role: ProjectRole;
  counts: ProjectCounts;
}

/** An item in a project, as its page lists it. */
export interface ProjectItem extends ProjectItemRef {
  name: string;
  /**
   * The role everyone in the project has in it through the project's row
   * in its sharing list; null when it isn't shared with the project.
   */
  sharedAs: ProjectRole | null;
  /** Whether the person builds the item, and so may share it. */
  builds: boolean;
}

/** Someone in a project. Times are ISO 8601. */
export interface ProjectMember extends ProjectMemberRef {
  /** The person's or team's name; null once they are gone. */
  name: string | null;
  role: ProjectRole;
  addedBy: string;
  addedAt: string;
}

/** A project, as its page shows it. */
export interface Project extends ProjectSummary {
  owner: { id: string; name: string | null };
  /** Whoever is in it besides its owner. */
  members: ProjectMember[];
  /** How many people a share with it reaches now, its owner included. */
  people: number;
  /**
   * What is filed in it, or shared with it, that the person may open: so
   * its builders see everything being in it reaches.
   */
  items: ProjectItem[];
}

/** An App or workflow the person may file in a project. */
export interface ProjectItemCandidate extends ProjectItemRef {
  name: string;
  /** Whether the person builds it, and so may also share it. */
  builds: boolean;
}

/** The organization's people and teams, by name, to add to a project. */
export interface ProjectShareCandidates {
  people: { id: string; name: string }[];
  teams: { id: string; name: string }[];
}

/** A signed-in person's projects (`session.projects`). */
export interface ProjectsApi {
  /** The projects the person is in, newest first; every one for an admin. */
  list: () => Promise<ProjectSummary[]>;
  get: (id: string) => Promise<Project>;
  /**
   * Makes a project, with the person as its owner and nothing in it, for
   * someone whose organization role builds.
   */
  create: (project: NewProject) => Promise<ProjectSummary>;
  /** Changes a project's name, description or icon, for its builders. */
  update: (id: string, changes: ProjectChanges) => Promise<void>;
  /**
   * Deletes a project, for its builders: nothing filed in it is deleted,
   * and every App and workflow shared with it stops being shared with it.
   */
  remove: (id: string) => Promise<void>;
  /** Adds someone to a project, or changes their role, for its builders. */
  addMember: (id: string, member: NewProjectMember) => Promise<void>;
  /**
   * Takes someone out of a project, for its builders: they lose what was
   * shared with the project on their next call.
   */
  removeMember: (id: string, member: ProjectMemberRef) => Promise<void>;
  /** Whom a project's builder may add to it. */
  shareCandidates: (id: string) => Promise<ProjectShareCandidates>;
  /** What the person may file in a project: what they can open, not in it yet. */
  itemCandidates: (id: string) => Promise<ProjectItemCandidate[]>;
  /**
   * Files an App or workflow the person can open in a project, for its
   * builders. Sharing it too (`share`) needs a builder of the item.
   */
  file: (id: string, file: FileItem) => Promise<void>;
  /**
   * Takes an item out of a project, for its builders. Its share with the
   * project, if any, goes with it.
   */
  unfile: (id: string, item: ProjectItemRef) => Promise<void>;
}

/** Why a call about projects was refused. */
export const projectErrors = defineErrorFamily({
  "project.invalid": "That isn't a valid request for a project.",
  "project.not_found": "There's no such project.",
  "project.member_invalid": "They can't be added to the project like that.",
  "project.item_not_found": "There's no such App or workflow you can open.",
  "project.conflict":
    "The project's sharing changed while it was being deleted. Try again.",
  "project.full": `A project holds at most ${projectItemsMax} apps and workflows, and ${projectMembersMax} people and teams besides its owner. Take one out to add another.`,
});
