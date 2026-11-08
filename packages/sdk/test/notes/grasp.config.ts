import { defineApp, permission, v } from "@grasp-os/sdk";

export const files = permission.files({
  operations: ["upload", "read", "attach"],
});

export const links = permission.links({
  origins: ["https://help.example.com"],
});

/** Summarizes a note: takes its ID, gives its summary. */
export const summarizeNote = permission.workflow("summarizeNote", {
  input: v.object({
    noteId: v.id("notes"),
    style: v.enum(["short", "long"]).default("short"),
  }),
  output: v.object({ summary: v.string(), words: v.number().integer() }),
});

/** Archives the notes: takes nothing, gives nothing. */
export const archiveNotes = permission.workflow("archiveNotes", {
  input: v.object({}),
  output: v.null(),
});

export default defineApp({
  name: "Notes",
  permissions: {
    files,
    links,
    workflows: [summarizeNote, archiveNotes],
  },
});
