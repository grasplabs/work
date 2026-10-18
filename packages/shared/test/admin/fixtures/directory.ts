import type { DirectoryTeam } from "../../../src/admin/onboarding.ts";

/** The client's directory: nine teams, 170 people, largest first, the way the brain lays them out. */
export const DIRECTORY: DirectoryTeam[] = [
  { id: "insurance", name: "Insurance advice", people: 42, pace: 0.78 },
  { id: "sales", name: "Sales", people: 38, pace: 0.72 },
  { id: "board", name: "Board and support", people: 30, pace: 0.8 },
  {
    id: "mortgage",
    name: "Mortgage advice",
    people: 18,
    pace: 0.88,
    lead: "Mark",
  },
  {
    id: "service",
    name: "Customer service",
    people: 14,
    pace: 0.24,
    lead: "Daan",
  },
  { id: "operations", name: "Operations", people: 9, pace: 0.7 },
  { id: "finance", name: "Finance", people: 8, pace: 0.92, lead: "Eva" },
  {
    id: "onboarding",
    name: "Client onboarding",
    people: 6,
    pace: 0.82,
    lead: "Nina",
  },
  { id: "compliance", name: "Compliance", people: 5, pace: 0.62 },
];
