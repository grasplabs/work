import type { Project } from "@grasp-os/shared/projects";

/**
 * Who is in `project`, by name: its owner, then the people and teams in
 * it, as a share with it reaches them. What a dialog names before someone
 * gains or loses access through the project.
 */
export const namesInProject = (
  project: Pick<Project, "owner" | "members">
): string[] =>
  [project.owner.name, ...project.members.map(({ name }) => name)].filter(
    (name): name is string => name !== null && name !== ""
  );
