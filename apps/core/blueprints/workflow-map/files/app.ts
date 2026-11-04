import { app } from "@grasp-os/sdk";

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
    },
  },
  screens: [{ name: "map", path: "/", source: "screens/map.tsx" }],
});
