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

/** Summarizes a note: takes its ID, gives its summary. */
export const summarizeNote = resource.workflow("summarizeNote", {
  input: v.object({
    noteId: v.id("notes"),
    style: v.enum(["short", "long"]).default("short"),
  }),
  output: v.object({ summary: v.string(), words: v.number().integer() }),
});

/** Archives the notes: takes nothing, gives nothing. */
export const archiveNotes = resource.workflow("archiveNotes", {
  input: v.object({}),
  output: v.null(),
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
  surfaces: [
    {
      name: "all",
      kind: "sidebar",
      screen: "notes",
      title: "All notes",
      input: v.object({}),
    },
    {
      name: "beside",
      kind: "panel",
      screen: "note",
      title: "Note",
      input: v.object({ id: v.id("notes") }),
    },
    {
      name: "shared",
      kind: "deepLink",
      screen: "note",
      title: "Shared note",
      input: v.object({ id: v.id("notes") }),
    },
  ],
  uses: [attachments, help, summarizeNote, archiveNotes],
});
