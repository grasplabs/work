import type { ProjectCounts } from "@grasp-os/shared/projects";
import { Plural, Trans } from "@lingui/react/macro";
import { LayoutGridIcon, PlugIcon, WorkflowIcon } from "lucide-react";

// What a project holds that the person may open, counted by core. Its
// hours, from its workflows' weekly measures, show once core keeps those
// (GRA-447).

/** How many workflows, Apps and connections a project holds. */
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
          <Trans>No Apps yet</Trans>
        ) : (
          <Plural one="# App" other="# Apps" value={apps} />
        )}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <PlugIcon aria-hidden="true" className="size-3.5" />
        <Plural one="# connection" other="# connections" value={connections} />
      </span>
    </div>
  );
};
