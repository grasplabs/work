import type { ProjectIcon as ProjectIconName } from "@grasp-os/shared/projects";
import {
  BuildingIcon,
  ChartColumnIcon,
  CoinsIcon,
  FolderIcon,
  LightbulbIcon,
  ListChecksIcon,
  RocketIcon,
  SparklesIcon,
  UsersIcon,
  WrenchIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";

// A project's icon, one of the few core keeps (`projectIcons`), drawn from
// Grasp UI's icons. The library has no target, briefcase or light bulb of
// its own: a checklist, a building and a thought stand in for them.

/** Each icon a project may have, as drawn. */
export const projectIconShapes: Record<ProjectIconName, IconData> = {
  folder: FolderIcon,
  briefcase: BuildingIcon,
  target: ListChecksIcon,
  users: UsersIcon,
  coins: CoinsIcon,
  rocket: RocketIcon,
  chart: ChartColumnIcon,
  lightbulb: LightbulbIcon,
  wrench: WrenchIcon,
  sparkles: SparklesIcon,
};
