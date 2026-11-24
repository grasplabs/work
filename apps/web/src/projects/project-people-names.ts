import type { Project } from "@grasp-os/shared/projects";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/** The rest of a list of people, past those named. */
const others = msg({
  message: "others",
  context: "the rest of a list of people",
});

/**
 * Who is in `project`, by name: its owner, then the people and teams of
 * its first page, and "others" when more are in it than that page holds.
 * What a dialog names before someone gains or loses access through the
 * project, for `formatList`.
 */
export const namesInProject = (
  project: Pick<Project, "owner" | "members" | "moreMembers">
): string[] => [
  ...[project.owner.name, ...project.members.map(({ name }) => name)].filter(
    (name): name is string => name !== null && name !== ""
  ),
  ...(project.moreMembers ? [i18n._(others)] : []),
];
