import { app, resource, v } from "@grasp-os/sdk";

import {
  count,
  create,
  exportAll,
  get,
  list,
  remove,
  setSummary,
  tally,
  update,
} from "./operations/notes.ts";
import schema from "./schema.ts";

export const attachments = resource.files("attachments", {
  operations: ["upload", "read", "attach"],
});

export const help = resource.links("help", {
  origins: ["https://help.example.com"],
});

export default app({
  name: "Notes",
  schema,
  access: {
    tables: {
      notes: { read: "owner", write: "owner" },
    },
  },
  operationAccess: {
    "notes.setSummary": {
      tables: { notes: { read: true, update: true } },
    },
  },
  operations: {
    notes: { list, get, create, update, remove, setSummary, tally, exportAll },
  },
  internalOperations: { notes: { count } },
  preferences: v.object({ compact: v.boolean().default(false) }),
  screens: [
    { name: "notes", path: "/", source: "screens/notes.tsx" },
    {
      name: "note",
      path: "/notes/:id",
      source: "screens/note.tsx",
      input: v.object({ id: v.id("notes") }),
    },
  ],
  uses: [attachments, help],
});
