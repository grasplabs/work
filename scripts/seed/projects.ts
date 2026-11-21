import type { ProjectIcon, ProjectRole } from "@grasp-os/shared/projects";

import type { PersonKey, TeamName } from "./company.ts";

/**
 * The demo company's projects: pieces of work with a goal and an end,
 * each bringing people from several teams together around the Apps the
 * work uses, and a few of their own chats, which only they see there. An
 * admin makes them, as one who builds every App and so may share each with
 * the project.
 */
export interface ProjectSeed {
  name: string;
  description: string;
  icon: ProjectIcon;
  /** The Apps in it, by name, and whether everyone in the project has each. */
  apps: { app: string; share: boolean }[];
  people: { person: PersonKey; role: ProjectRole }[];
  teams: { team: TeamName; role: ProjectRole }[];
  /** Chats of people in it (scripts/seed/chats.ts), by title, each filed by its own person. */
  chats: { by: PersonKey; title: string }[];
}

export const projects: ProjectSeed[] = [
  {
    name: "Year-end close 2026",
    description:
      "Close the books for 2026 by 20 January, with the board pack ready.",
    icon: "target",
    apps: [
      { app: "Record-to-Report", share: true },
      { app: "Purchase-to-Pay", share: false },
    ],
    people: [{ person: "eva", role: "builder" }],
    teams: [{ team: "Finance", role: "user" }],
    chats: [
      { by: "sanne", title: "This week for the board" },
      { by: "eva", title: "Invoices waiting longest" },
    ],
  },
  {
    name: "Move to Exact Online",
    description:
      "Switch the bookkeeping to Exact Online before 1 March without missing a day of invoicing.",
    icon: "rocket",
    apps: [
      { app: "Opportunity-to-Cash", share: true },
      { app: "Purchase-to-Pay", share: true },
    ],
    people: [
      { person: "nina", role: "builder" },
      { person: "eva", role: "builder" },
      { person: "joost", role: "user" },
    ],
    teams: [],
    chats: [{ by: "nina", title: "Files without a payslip" }],
  },
];
