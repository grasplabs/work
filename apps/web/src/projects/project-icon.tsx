import type { ProjectIcon as ProjectIconName } from "@grasp-os/shared/projects";
import {
  BriefcaseIcon,
  ChartLineIcon,
  CoinsIcon,
  FolderIcon,
  LightbulbIcon,
  RocketIcon,
  SparklesIcon,
  TargetIcon,
  UsersIcon,
  WrenchIcon,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";

// A project's icon, one of the few core keeps (`projectIcons`), drawn on a
// grey tile as a domain's is (engines/engine-icon.tsx).

/** Each icon a project may have, as drawn. */
export const projectIconShapes: Record<
  ProjectIconName,
  ComponentType<SVGProps<SVGSVGElement>>
> = {
  folder: FolderIcon,
  briefcase: BriefcaseIcon,
  target: TargetIcon,
  users: UsersIcon,
  coins: CoinsIcon,
  rocket: RocketIcon,
  chart: ChartLineIcon,
  lightbulb: LightbulbIcon,
  wrench: WrenchIcon,
  sparkles: SparklesIcon,
};

/** A project's icon on its tile. */
export const ProjectIcon = ({ icon }: { icon: ProjectIconName }) => {
  const Shape = projectIconShapes[icon];
  return (
    <span
      aria-hidden="true"
      className="bg-muted text-foreground inline-flex size-7.5 flex-none items-center justify-center rounded-lg"
    >
      <Shape className="size-4" />
    </span>
  );
};
