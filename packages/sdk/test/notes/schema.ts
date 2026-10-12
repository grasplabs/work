import { defineSchema, defineTable, v } from "@grasp-os/sdk";

// The Notes App of spec 8 and 9.4, laid out as an App is in the product:
// this file, `app.ts` and `operations/` are its source; `.grasp/` holds
// what the host generates from it (references.test.ts keeps it current).

export const noteFields = {
  title: v.string().trim().min(1).max(200),
  body: v.string().max(100_000).default(""),
  summary: v.string().max(10_000).nullable().default(null),
};

export default defineSchema({
  notes: defineTable(noteFields)
    .index("by_updated", ["_updatedAt"])
    .index("by_title", ["title"]),
});
