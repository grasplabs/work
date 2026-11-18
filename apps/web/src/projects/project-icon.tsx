import type { ProjectIcon as ProjectIconName } from "@grasp-os/shared/projects";

import {
  Chart,
  Checklist,
  Company,
  Folder,
  Money,
  People,
  Rocket,
  Sparkles,
  Thought,
  Tool,
} from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";

// A project's icon, one of the few core keeps (`projectIcons`), drawn from
// Grasp UI's icons. The library has no target, briefcase or light bulb of
// its own: a checklist, a building and a thought stand in for them.

/** Each icon a project may have, as drawn. */
export const projectIconShapes: Record<ProjectIconName, IconData> = {
  folder: Folder,
  briefcase: Company,
  target: Checklist,
  users: People,
  coins: Money,
  rocket: Rocket,
  chart: Chart,
  lightbulb: Thought,
  wrench: Tool,
  sparkles: Sparkles,
};
