import { defineSchema, defineTable, v } from "@grasp-os/sdk";

// The intake's business store: drafts of a source and the statements taken
// from it, kept while someone reviews them, and the sources and statements
// saved from them. Only the App's builders (an admin is one on every App)
// read or write any of it (app.ts): intake is theirs.

/** What a statement can be about: its tags. */
export const statementTags = [
  "goal",
  "blocker",
  "time_sink",
  "handover",
  "tool",
  "rule",
] as const;

/** How a source was given. */
export const sourceMedia = ["interview", "chat", "document", "other"] as const;

/**
 * Where a draft came from: typed in by hand, taken out of notes by a
 * model, or out of a stakeholder's chat, whose words are untrusted.
 */
export const draftOrigins = ["manual", "notes", "guest"] as const;

/** Longest title, name or claim. */
export const shortTextMax = 200;

/** Longest quote. */
export const quoteMax = 1000;

/** Longest notes: well inside a stored record (128 KiB). */
export const notesMax = 30_000;

/**
 * Most statements one draft holds: a save writes its source and each
 * statement, and drops the draft, in one commit of at most 100 writes.
 */
export const statementsMax = 90;

/** A source as a draft holds it, and as it is saved. */
export const sourceFields = {
  title: v.string().trim().min(1).max(shortTextMax),
  medium: v.enum(sourceMedia),
  /** YYYY-MM-DD: a calendar date that exists (checked where it is kept). */
  date: v.string().min(10).max(10),
  /** Who it came from: a name or a role; empty when unknown. */
  from: v.string().trim().max(shortTextMax),
  /** The notes it was taken from. */
  notes: v.string().trim().max(notesMax),
};

/** One claim from a source, as a draft holds it. */
export const statementFields = {
  /** The claim itself. */
  text: v.string().trim().min(1).max(shortTextMax),
  tags: v.array(v.enum(statementTags)).min(1).max(statementTags.length),
  /** What the source said, briefly; empty for none. */
  quote: v.string().trim().max(quoteMax),
};

/** A draft: a source and the statements taken from it. */
export const draftFields = {
  source: v.object(sourceFields),
  statements: v.array(v.object(statementFields)).max(statementsMax),
};

export default defineSchema({
  drafts: defineTable({
    ...draftFields,
    origin: v.enum(draftOrigins),
  }).index("by_created", ["_createdAt"]),
  sources: defineTable({
    ...sourceFields,
    /**
     * Taken from what someone outside the company wrote in a chat they
     * were invited to by link: untrusted text. Only the save sets it.
     */
    guest: v.boolean(),
  }).index("by_created", ["_createdAt"]),
  statements: defineTable({
    ...statementFields,
    source: v.id("sources"),
    /** The source's date. */
    date: v.string().min(10).max(10),
    /** Taken from a guest's words, like its source. Only the save sets it. */
    guest: v.boolean(),
  }).index("by_source", ["source"]),
});
