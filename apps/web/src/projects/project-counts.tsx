import type { ProjectCounts } from "@grasp-os/shared/projects";
import { Plural } from "@lingui/react/macro";
import { Fragment } from "react";
import type { ReactNode } from "react";

// What a project holds that the person may open, counted by core, in one
// quiet line: only what it has, so a project with nothing in it says
// nothing. Its hours, from its workflows' weekly measures, show once core
// keeps those (GRA-447).

/** How many Apps, workflows and connections a project holds, or `undefined` for none. */
export const projectCountsWords = ({
  apps,
  workflows,
  connections,
}: ProjectCounts): ReactNode => {
  const parts = [
    apps === 0 ? null : (
      <Plural key="apps" one="# App" other="# Apps" value={apps} />
    ),
    workflows === 0 ? null : (
      <Plural
        key="workflows"
        one="# workflow"
        other="# workflows"
        value={workflows}
      />
    ),
    connections === 0 ? null : (
      <Plural
        key="connections"
        one="# connection"
        other="# connections"
        value={connections}
      />
    ),
  ].filter((part) => part !== null);
  if (parts.length === 0) {
    return undefined;
  }
  return parts.map((part, index) => (
    <Fragment key={part.key}>
      {index === 0 ? null : " · "}
      {part}
    </Fragment>
  ));
};
