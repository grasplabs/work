import { app } from "@grasp-os/sdk";

import { builder, writable } from "./operations/access.ts";
import { list as figureList } from "./operations/figures.ts";
import { add, list as teamList } from "./operations/teams.ts";
import { link, list, open, save, version } from "./operations/workflows.ts";
import schema from "./schema.ts";

// The workflow map: the company's workflows as they run now (drawn) and
// as they should (designed), with their numbers, in the App's own store
// (schema.ts). Everyone who may open the App reads them; only its builders
// (an admin is one on every App) change them, which the store checks on
// every write. It reaches nothing outside its store.

const members = { read: "appMembers", write: "appBuilders" } as const;

export default app({
  name: "Workflow map",
  schema,
  access: {
    tables: {
      teams: members,
      workflows: members,
      workflowVersions: members,
      builders: { read: "appBuilders", write: "none" },
    },
  },
  operations: {
    access: { writable },
    figures: { list: figureList },
    teams: { list: teamList, add },
    map: { list, open, version, save, link },
  },
  internalOperations: { access: { builder } },
  screens: [{ name: "map", path: "/", source: "screens/map.tsx" }],
  uses: [],
});
