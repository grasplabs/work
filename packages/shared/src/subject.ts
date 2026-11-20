import { z } from "zod";

// What a draft, a version, a question or a chat's work is about: an App or
// a workflow, by its ID. Apps and workflows share one draft system and one
// set of versions (core's drafts.ts and publish.ts), each named by this.

/** The kinds of thing that have a draft and versions of their own. */
export const subjectKinds = ["app", "workflow"] as const;
export type SubjectKind = (typeof subjectKinds)[number];

/** One App or workflow, by its kind and ID. */
export const subjectSchema = z.strictObject({
  kind: z.enum(subjectKinds),
  id: z.string().min(1).max(256),
});
export type Subject = z.infer<typeof subjectSchema>;
