import { defineApp, permission, v } from "@grasp-os/sdk";

export const files = permission.files({
  operations: ["upload", "read", "attach"],
});

export const links = permission.links({
  origins: ["https://help.example.com"],
});

/**
 * Summarizes a note: takes its ID, gives its summary. It listens for two
 * events in two tasks and asks two decisions of different values.
 */
export const summarizeNote = permission.workflow("summarizeNote", {
  args: v.object({
    noteId: v.id("notes"),
    style: v.enum(["short", "long"]).default("short"),
  }),
  returns: v.object({ summary: v.string(), words: v.number().integer() }),
  events: {
    styleChosen: {
      type: "notes.summary.style_chosen",
      data: v.object({ style: v.enum(["short", "long"]) }),
    },
    noteEdited: {
      type: "notes.note.edited",
      data: v.object({ noteId: v.id("notes"), title: v.string().optional() }),
    },
  },
  listens: {
    "do/0/chooseStyle": ["styleChosen"],
    "do/2/awaitEdit": ["noteEdited", "styleChosen"],
  },
  decisions: {
    approveSummary: {
      value: v.object({
        comment: v.string().max(500),
        rating: v.number().integer().min(1).max(5).optional(),
      }),
      context: v.object({ noteId: v.id("notes"), summary: v.string() }),
    },
    chooseLength: {
      value: v.enum(["short", "long"]),
      context: v.object({ words: v.number().integer() }),
    },
  },
});

/**
 * Archives the notes: takes nothing, gives nothing. It listens for a
 * confirmation and asks one decision with no value.
 */
export const archiveNotes = permission.workflow("archiveNotes", {
  args: v.object({}),
  returns: v.null(),
  events: {
    confirmed: {
      type: "notes.archive.confirmed",
      data: v.object({ confirmed: v.boolean() }),
    },
  },
  listens: { "do/0/confirm": ["confirmed"] },
  decisions: {
    confirmArchive: {
      value: v.null(),
      context: v.object({ count: v.number().integer() }),
    },
  },
});

export default defineApp({
  name: "Notes",
  permissions: {
    files,
    links,
    workflows: [summarizeNote, archiveNotes],
  },
});
