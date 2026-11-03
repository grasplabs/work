import type { ProjectCounts } from "@grasp-os/shared/projects";
import { Plural, Trans } from "@lingui/react/macro";
import {
  ClockIcon,
  LayoutGridIcon,
  PlugIcon,
  WorkflowIcon,
} from "lucide-react";

// What a project holds that the person may open, counted by core, and its
// hours. Hours come from its workflows' weekly measures, which core
// doesn't keep yet (GRA-447): until it does, every project says it has
// none, and there is no bar of saved, expected and still-manual hours to
// draw, nor a legend for one.

/** A project's hours a week: none measured yet. */
export const ProjectHours = () => (
  <span className="text-muted-foreground inline-flex items-center gap-1.5">
    <ClockIcon aria-hidden="true" className="size-3.5" />
    <Trans>No hours measured yet</Trans>
  </span>
);

/** How many workflows, apps and connections a project holds. */
export const ProjectCountsLine = ({ counts }: { counts: ProjectCounts }) => {
  const { workflows, apps, connections } = counts;
  return (
    <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
      <span className="inline-flex items-center gap-1.5">
        <WorkflowIcon aria-hidden="true" className="size-3.5" />
        {workflows === 0 ? (
          <Trans>No workflows yet</Trans>
        ) : (
          <Plural one="# workflow" other="# workflows" value={workflows} />
        )}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <LayoutGridIcon aria-hidden="true" className="size-3.5" />
        {apps === 0 ? (
          <Trans>No apps yet</Trans>
        ) : (
          <Plural one="# app" other="# apps" value={apps} />
        )}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <PlugIcon aria-hidden="true" className="size-3.5" />
        <Plural one="# connection" other="# connections" value={connections} />
      </span>
    </div>
  );
};
