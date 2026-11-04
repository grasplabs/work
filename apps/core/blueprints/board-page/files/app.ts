import { app } from "@grasp-os/sdk";

import schema from "./schema.ts";
import { grasp, map } from "./server/snapshots.ts";

// The board page: dated snapshots of the workflow map's numbers and what
// runs, each shown on one page for the board, in the App's own store
// (schema.ts). Everyone who may open the App reads them; only its
// builders (an admin is one on every App) take them and write their
// narratives, which the store checks on every write.
//
// It reads the workflow map through `map`, which an admin binds to the
// map App on the engine's Resources tab, and the platform's counts of
// runs through `grasp`, the platform's own read-only functions, bound to
// the `PLATFORM` permission an admin grants. Until `map` is bound, taking
// a snapshot fails with `resource.unavailable`; until `grasp` is, what
// runs is unavailable.

const members = { read: "appMembers", write: "appBuilders" } as const;

export default app({
  name: "Board page",
  schema,
  access: {
    tables: {
      snapshots: members,
      figures: members,
    },
  },
  screens: [{ name: "board", path: "/", source: "screens/board.tsx" }],
  permissions: { apps: [map, grasp] },
});
