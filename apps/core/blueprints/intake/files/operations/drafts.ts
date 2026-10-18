import { AppError, v } from "@grasp-os/sdk";

import { doc, mutation, query } from "#grasp/server";

import { draftFields, draftOrigins, statementsMax } from "../schema.ts";

// Drafts of a source and the statements taken from it, reviewed and
// edited before they are saved as a `source` and its `statements`. Each
// draft is typed in by hand (`create`), or proposed by a run of the
// `extract` workflow (`propose`), which took the statements out of someone's
// notes or a stakeholder's chat. Only the App's builders reach any of it:
// the store refuses everyone else (app.ts).

/** Most drafts the review lists: the newest. */
const listed = 100;

/** Most saved sources the screen lists: the newest. */
const savedListed = 50;

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

/** A calendar date as YYYY-MM-DD, one that exists (`2026-02-30` doesn't). */
const isDate = (value: string): boolean =>
  datePattern.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

/** A draft as the review lists it. */
const summary = v.object({
  id: v.id("drafts"),
  revision: v.number().integer().min(1),
  origin: v.enum(draftOrigins),
  title: v.string(),
  date: v.string(),
  statements: v.number().integer().min(0),
  createdAt: v.timestamp(),
});

/** A draft's source and statements, as an edit or a save sends them. */
const draftArgs = draftFields;

/** Refuses a draft whose source's date doesn't exist (`intake.invalid`). */
const requireDate = (date: string): void => {
  if (!isDate(date)) {
    throw new AppError(
      "intake.invalid",
      "The date isn't a date that exists (YYYY-MM-DD)."
    );
  }
};

/** Each statement's tags once, in the order they are listed in. */
const tagsInOrder = <Tag extends string>(tags: readonly Tag[]): Tag[] => [
  ...new Set(tags),
];

/**
 * Whether the caller may review drafts: true, or refused by the store
 * (`data.access_denied`) for anyone but the App's builders. The intake's
 * actions check it first (chats.ts), and the screen asks it through them.
 */
export const reviewer = query({
  args: {},
  returns: v.literal(true),
  handler: async (ctx) => {
    await ctx.db.query("drafts").withIndex("by_created").take(1);
    return true as const;
  },
});

/** The drafts waiting for review, newest first. */
export const list = query({
  args: {},
  returns: v.array(summary).max(listed),
  handler: async (ctx) => {
    const drafts = await ctx.db
      .query("drafts")
      .withIndex("by_created")
      .order("desc")
      .take(listed);
    return drafts.map((draft) => ({
      id: draft._id,
      revision: draft._rev,
      origin: draft.origin,
      title: draft.source.title,
      date: draft.source.date,
      statements: draft.statements.length,
      createdAt: draft._createdAt,
    }));
  },
});

/** A draft, to review; null once it was saved or discarded. */
export const get = query({
  args: { id: v.id("drafts") },
  returns: doc("drafts").nullable(),
  handler: async (ctx, args) => await ctx.db.get("drafts", args.id),
});

/** The sources saved most recently, newest first. */
export const saved = query({
  args: {},
  returns: v.array(doc("sources")).max(savedListed),
  handler: async (ctx) =>
    await ctx.db
      .query("sources")
      .withIndex("by_created")
      .order("desc")
      .take(savedListed),
});

/** A saved source's statements. */
export const statementsOf = query({
  args: { source: v.id("sources") },
  returns: v.array(doc("statements")).max(statementsMax),
  handler: async (ctx, args) =>
    await ctx.db
      .query("statements")
      .withIndex("by_source", (range) => range.eq("source", args.source))
      .take(statementsMax),
});

/** Starts a draft by hand, with what the screen typed. */
export const create = mutation({
  args: draftArgs,
  returns: v.id("drafts"),
  handler: async (ctx, args) => {
    requireDate(args.source.date);
    return await ctx.db.insert("drafts", {
      source: args.source,
      statements: args.statements.map((statement) => ({
        ...statement,
        tags: tagsInOrder(statement.tags),
      })),
      origin: "manual",
    });
  },
});

/**
 * Keeps a draft a run of `extract` proposes, for review: out of notes, or
 * out of a stakeholder's chat (`guest`), whose words are untrusted. Run
 * again under the step's key, it answers the draft it kept the first
 * time. Called by anyone else who may write drafts (a builder), it keeps
 * a draft as theirs to review, as `create` does. `guest` records where
 * the draft came from, not who may be trusted: the App's builders are,
 * and one may mark a draft either way. A chat's words are marked by the
 * run that read them, which a builder started.
 */
export const propose = mutation({
  args: { ...draftArgs, guest: v.boolean() },
  returns: v.id("drafts"),
  handler: async (ctx, args) => {
    requireDate(args.source.date);
    return await ctx.db.insert("drafts", {
      source: args.source,
      statements: args.statements.map((statement) => ({
        ...statement,
        tags: tagsInOrder(statement.tags),
      })),
      origin: args.guest ? "guest" : "notes",
    });
  },
});

/**
 * Keeps the edits of a draft at `expectedRevision` as its next revision,
 * without saving it yet. Where it came from never changes: an edit of a
 * stakeholder's draft is still theirs (`data.conflict` when someone kept,
 * saved or discarded it since).
 */
export const keep = mutation({
  args: {
    id: v.id("drafts"),
    expectedRevision: v.number().integer().min(1),
    ...draftArgs,
  },
  returns: v.number().integer().min(1),
  handler: async (ctx, args) => {
    requireDate(args.source.date);
    await ctx.db.patch(
      "drafts",
      args.id,
      {
        source: args.source,
        statements: args.statements.map((statement) => ({
          ...statement,
          tags: tagsInOrder(statement.tags),
        })),
      },
      { expectedRevision: args.expectedRevision }
    );
    // The revision the commit gives it, as a staged read shows it: one
    // more only when the edits change it, so not always one more.
    const kept = await ctx.db.get("drafts", args.id);
    if (kept === null) {
      throw new AppError(
        "intake.not_found",
        "This draft is gone: someone saved or discarded it."
      );
    }
    return kept._rev;
  },
});

/** Throws a draft away, at `expectedRevision`. */
export const discard = mutation({
  args: {
    id: v.id("drafts"),
    expectedRevision: v.number().integer().min(1),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.delete("drafts", args.id, {
      expectedRevision: args.expectedRevision,
    });
    return null;
  },
});

/**
 * Saves a draft, as it was edited, at `expectedRevision`: its source, a
 * statement for each claim naming it, and drops the draft, all in one
 * commit, so a save is whole or not at all, and a save run again under
 * its key saves nothing twice. A stakeholder's draft (`guest`) is saved
 * marked as theirs, which only this sets. A draft needs a statement
 * (`intake.no_statements`).
 */
export const save = mutation({
  args: {
    id: v.id("drafts"),
    expectedRevision: v.number().integer().min(1),
    ...draftArgs,
  },
  returns: v.object({
    source: v.id("sources"),
    statements: v.number().integer().min(1),
  }),
  handler: async (ctx, args) => {
    requireDate(args.source.date);
    if (args.statements.length === 0) {
      throw new AppError("intake.no_statements", "Add a statement to save.");
    }
    const stored = await ctx.db.get("drafts", args.id);
    if (stored === null) {
      throw new AppError(
        "intake.not_found",
        "This draft is gone: someone saved or discarded it."
      );
    }
    const guest = stored.origin === "guest";
    const source = await ctx.db.insert("sources", { ...args.source, guest });
    for (const statement of args.statements) {
      // oxlint-disable-next-line no-await-in-loop -- staged in order, committed together
      await ctx.db.insert("statements", {
        ...statement,
        tags: tagsInOrder(statement.tags),
        source,
        date: args.source.date,
        guest,
      });
    }
    await ctx.db.delete("drafts", args.id, {
      expectedRevision: args.expectedRevision,
    });
    return { source, statements: args.statements.length };
  },
});
