import { app } from "@grasp-os/sdk";

import { builder, writable } from "./operations/access.ts";
import {
  addFigures,
  figures,
  finish,
  get,
  list,
  map,
  statistics,
  take,
  write,
} from "./operations/snapshots.ts";
import schema from "./schema.ts";

// The board page: dated snapshots of the workflow map's numbers and what
// runs, each shown on one page for the board, in the App's own store
// (schema.ts). Everyone who may open the App reads them; only its
// builders (an admin is one on every App) take them and write their
// narratives, which the store checks on every write.
//
// It reads the workflow map through `map`, which an admin binds to the
// map App on the engine's Resources tab, and the platform's counts of
// runs through `statistics`, bound to the `PLATFORM` permission an admin
// grants. Until `map` is bound, taking a snapshot fails with
// `resource.unavailable`; until `statistics` is, what runs is unavailable.

const members = { read: "appMembers", write: "appBuilders" } as const;

export default app({
  name: "Board page",
  schema,
  access: {
    tables: {
      snapshots: members,
      figures: members,
      builders: { read: "appBuilders", write: "none" },
    },
  },
  operations: {
    access: { writable },
    snapshots: { list, get, figures, take, write },
  },
  internalOperations: {
    access: { builder },
    snapshots: { addFigures, finish },
  },
  screens: [{ name: "board", path: "/", source: "screens/board.tsx" }],
  uses: [map, statistics],
});
