import {
  AppError,
  paginationOptionsValidator,
  paginationResultValidator,
  v,
} from "@grasp-os/sdk";

import { doc, mutation, query } from "#grasp/server";
import type { Doc, Id, MutationCtx } from "#grasp/server";

import { appLink, editedFields, workflowStates } from "../schema.ts";

// The map's workflows: listed, opened beside the version of them last
// drawn, saved and linked to the App workflow built from them. Each save
// and link writes the workflow's next version and a copy of it
// (`workflowVersions`) in one commit, pinned to the revision it was read
// at, so no one's edits are written over and no version is lost. What only
// the map sets, it sets here: a designed workflow's `drawnVersion` (save)
// and its `app` (link). Whatever a save is sent of them is not taken.

/** Most workflows one page lists, whatever the page asks for. */
const pageMax = 10;

/**
 * Most bytes a workflow takes as JSON without its notes: so a page of the
 * list, which leaves notes out, stays within what a query may answer
 * (256 KiB). Each field's limit holds on its own, but steps and
 * parameters at their longest together don't fit.
 */
const listedBytesMax = 24 * 1024;

const encoder = new TextEncoder();

/** A workflow as the list shows it: everything but its notes. */
const summary = v.object({
  id: v.id("workflows"),
  revision: v.number().integer().min(1),
  version: v.number().integer().min(1),
  title: editedFields.title,
  state: v.enum(workflowStates),
  team: editedFields.team,
  steps: editedFields.steps,
  parameters: editedFields.parameters,
  gain: editedFields.gain,
  app: appLink.nullable(),
});

const summaryOf = (workflow: Doc<"workflows">) => ({
  id: workflow._id,
  revision: workflow._rev,
  version: workflow.version,
  title: workflow.title,
  state: workflow.state,
  team: workflow.team,
  steps: workflow.steps,
  parameters: workflow.parameters,
  gain: workflow.gain,
  app: workflow.app,
});

/** Refuses a workflow too large for a page of the list (`map.too_large`). */
const requireListable = (fields: Record<string, unknown>): void => {
  const { notes: _notes, ...listed } = fields;
  if (encoder.encode(JSON.stringify(listed)).byteLength > listedBytesMax) {
    throw new AppError(
      "map.too_large",
      "This workflow is too large to list: shorten its steps or parameters."
    );
  }
};

/** Writes `next` as the workflow's next version, and keeps a copy of it. */
const writeVersion = async (
  ctx: MutationCtx,
  id: Id<"workflows">,
  expectedRevision: number,
  next: Omit<
    Doc<"workflows">,
    "_id" | "_rev" | "_ownerId" | "_createdAt" | "_updatedAt"
  >
): Promise<void> => {
  requireListable(next);
  await ctx.db.patch("workflows", id, next, { expectedRevision });
  await ctx.db.insert("workflowVersions", { ...next, workflow: id });
};

/** The workflows, a page at a time, by title. */
export const list = query({
  args: { pagination: paginationOptionsValidator },
  returns: paginationResultValidator(summary),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("workflows")
      .withIndex("by_title")
      .paginate({
        cursor: args.pagination.cursor,
        pageSize: Math.min(args.pagination.pageSize, pageMax),
      });
    return { ...page, items: page.items.map(summaryOf) };
  },
});

/**
 * A workflow with its notes, and for a designed one, the version of it
 * last drawn, to set beside it; null for a workflow that isn't there.
 */
export const open = query({
  args: { id: v.id("workflows") },
  returns: v
    .object({
      current: doc("workflows"),
      drawn: doc("workflowVersions").nullable(),
    })
    .nullable(),
  handler: async (ctx, args) => {
    const current = await ctx.db.get("workflows", args.id);
    if (current === null) {
      return null;
    }
    if (current.state !== "designed" || current.drawnVersion === null) {
      return { current, drawn: null };
    }
    const [drawn] = await ctx.db
      .query("workflowVersions")
      .withIndex("by_workflow", (range) =>
        range.eq("workflow", args.id).eq("version", current.drawnVersion ?? 0)
      )
      .take(1);
    return { current, drawn: drawn ?? null };
  },
});

/** A version of a workflow, as it was saved; null when there is none. */
export const version = query({
  args: { id: v.id("workflows"), version: v.number().integer().min(1) },
  returns: doc("workflowVersions").nullable(),
  handler: async (ctx, args) => {
    const [found] = await ctx.db
      .query("workflowVersions")
      .withIndex("by_workflow", (range) =>
        range.eq("workflow", args.id).eq("version", args.version)
      )
      .take(1);
    return found ?? null;
  },
});

/**
 * Saves a workflow: a new one (`id` null), or the next version of one
 * read at `expectedRevision`. A designed workflow keeps the version of it
 * last drawn: the version saved before, when that one was drawn,
 * otherwise the one it kept. Its link to an App workflow is kept as it is,
 * and a linked one stays designed (`map.linked_drawn`).
 */
export const save = mutation({
  args: {
    id: v.id("workflows").nullable(),
    expectedRevision: v.number().integer().min(1).nullable(),
    ...editedFields,
  },
  returns: v.object({
    id: v.id("workflows"),
    version: v.number().integer().min(1),
  }),
  handler: async (ctx, args) => {
    const { id, expectedRevision, ...edited } = args;
    if (id === null) {
      if (edited.state === "designed") {
        throw new AppError(
          "map.not_drawn",
          "A workflow is drawn before it is designed."
        );
      }
      const first = { ...edited, version: 1, drawnVersion: null, app: null };
      requireListable(first);
      const created = await ctx.db.insert("workflows", first);
      await ctx.db.insert("workflowVersions", { ...first, workflow: created });
      return { id: created, version: 1 };
    }
    const stored = await ctx.db.get("workflows", id);
    if (stored === null || expectedRevision === null) {
      throw new AppError("map.not_found", "This workflow is gone.");
    }
    if (edited.state === "drawn" && stored.app !== null) {
      throw new AppError(
        "map.linked_drawn",
        "A workflow linked to an App workflow stays designed."
      );
    }
    const drawnBefore =
      stored.state === "drawn" ? stored.version : stored.drawnVersion;
    const next = {
      ...edited,
      version: stored.version + 1,
      drawnVersion: edited.state === "designed" ? drawnBefore : null,
      app: stored.app,
    };
    await writeVersion(ctx, id, expectedRevision, next);
    return { id, version: next.version };
  },
});

/**
 * Links a designed workflow, read at `expectedRevision`, to the App
 * workflow built from it, by the App's and the workflow's IDs, as its next
 * version: the one function that sets `app`. A drawn workflow is refused
 * (`map.not_designed`).
 */
export const link = mutation({
  args: {
    id: v.id("workflows"),
    expectedRevision: v.number().integer().min(1),
    app: appLink,
  },
  returns: v.object({ version: v.number().integer().min(1) }),
  handler: async (ctx, args) => {
    const stored = await ctx.db.get("workflows", args.id);
    if (stored === null) {
      throw new AppError("map.not_found", "This workflow is gone.");
    }
    if (stored.state !== "designed") {
      throw new AppError(
        "map.not_designed",
        "Only a designed workflow links to an App workflow."
      );
    }
    const {
      _id: _kept,
      _rev: _revision,
      _ownerId: _owner,
      _createdAt: _created,
      _updatedAt: _updated,
      ...fields
    } = stored;
    const next = { ...fields, version: stored.version + 1, app: args.app };
    await writeVersion(ctx, args.id, args.expectedRevision, next);
    return { version: next.version };
  },
});
