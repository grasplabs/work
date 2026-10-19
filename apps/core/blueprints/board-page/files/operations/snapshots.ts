import {
  AppError,
  paginationOptionsValidator,
  paginationResultValidator,
  resource,
  v,
} from "@grasp-os/sdk";

import { action, doc, internalMutation, mutation, query } from "#grasp/server";

import {
  decisionMax,
  figureFields,
  figuresMax,
  maturityMax,
  narrativeMax,
  signalFields,
} from "../schema.ts";
import { mapFigures } from "../values.ts";
import { builder } from "./access.ts";
import { freeze, windowDays } from "./freeze.ts";
import type { MapFigure } from "./freeze.ts";

// The board page's snapshots: listed, opened with their figures, taken,
// and their narrative and decision written. `take` reads the workflow
// map's numbers (`map`, an App an admin binds the resource to) and the
// platform's counts of what runs (`statistics`, under the permission an
// admin grants), as the person taking it, and writes what it froze: each
// workflow's figures first, then the snapshot, which lists them, so a
// snapshot is never seen with part of them. What it froze, only `take`
// writes; `write` changes the narrative and the decision alone.

/** The workflow map, as the page reads its numbers. */
export const map = resource.app("map", {
  functions: { "figures.list": mapFigures },
});

/** The platform's counts of runs and improvement signals. */
export const statistics = resource.statistics("statistics", {
  operations: ["read"],
  platform: ["platform.workflow_runs", "platform.improvement_signals"],
});

/** Workflows one page of the map holds: as many as it gives. */
const mapPage = 50;

/** Figures one write holds: within a commit's 100 writes. */
const figuresPerWrite = 50;

/**
 * Figures one page of a snapshot holds. A figure at its longest is about
 * 2.7 KB of JSON: a title and a team's of 200 characters, 3 bytes each at
 * most (the map refuses what JSON writes longer), the running App
 * workflow's two IDs of 256 ASCII characters, its numbers, and the
 * record's own fields. 50 of them are about 135 KB, well within the
 * 256 KiB a query answers.
 */
const figuresPage = 50;

/** Snapshots one page of the list holds. */
const listPage = 20;

/** A snapshot as the list shows it. */
const listed = v.object({
  id: v.id("snapshots"),
  title: v.string(),
  date: v.string(),
  createdAt: v.timestamp(),
});

/** The snapshots, newest first, a page at a time. */
export const list = query({
  args: { pagination: paginationOptionsValidator },
  returns: paginationResultValidator(listed),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("snapshots")
      .withIndex("by_created")
      .order("desc")
      .paginate({
        cursor: args.pagination.cursor,
        pageSize: Math.min(args.pagination.pageSize, listPage),
      });
    return {
      ...page,
      items: page.items.map((snapshot) => ({
        id: snapshot._id,
        title: snapshot.title,
        date: snapshot.date,
        createdAt: snapshot._createdAt,
      })),
    };
  },
});

/** A snapshot, without its figures; null when there is none. */
export const get = query({
  args: { id: v.id("snapshots") },
  returns: doc("snapshots").nullable(),
  handler: async (ctx, args) => await ctx.db.get("snapshots", args.id),
});

/** A snapshot's figures, in their order, a page at a time. */
export const figures = query({
  args: {
    take: v.string().min(1).max(64),
    pagination: paginationOptionsValidator,
  },
  returns: paginationResultValidator(doc("figures")),
  handler: async (ctx, args) =>
    await ctx.db
      .query("figures")
      .withIndex("by_take", (range) => range.eq("take", args.take))
      .paginate({
        cursor: args.pagination.cursor,
        pageSize: Math.min(args.pagination.pageSize, figuresPage),
      }),
});

/** Writes some of a snapshot's figures, before the snapshot itself. */
export const addFigures = internalMutation({
  args: {
    figures: v.array(v.object(figureFields)).max(figuresPerWrite),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const figure of args.figures) {
      // oxlint-disable-next-line no-await-in-loop -- staged in order, committed together
      await ctx.db.insert("figures", figure);
    }
    return null;
  },
});

/**
 * Writes a snapshot, with the last of its figures, once each other is: one
 * commit for a snapshot of up to `figuresPerWrite` workflows.
 */
export const finish = internalMutation({
  args: {
    last: v.array(v.object(figureFields)).max(figuresPerWrite),
    take: v.string().min(1).max(64),
    title: v.string(),
    date: v.string().min(10).max(10),
    maturity: v.number().integer().min(0).max(maturityMax),
    windowDays: v.number().integer().min(1).max(366),
    figures: v.number().integer().min(0),
    signals: v.array(signalFields),
    decisionNeeded: v.string().trim().max(decisionMax),
  },
  returns: v.id("snapshots"),
  handler: async (ctx, args) => {
    const { last, ...snapshot } = args;
    for (const figure of last) {
      // oxlint-disable-next-line no-await-in-loop -- staged in order, committed together
      await ctx.db.insert("figures", figure);
    }
    return await ctx.db.insert("snapshots", { ...snapshot, narrative: "" });
  },
});

/**
 * Takes a snapshot now, with the maturity it records and the decision it
 * asks for: every workflow of the map, frozen with its hours, and the
 * improvement signals of the App workflows they link to. Only the App's
 * builders take one: refused before anything is read for anyone else.
 */
export const take = action({
  args: {
    maturity: v.number().integer().min(0).max(maturityMax),
    decisionNeeded: v.string().trim().max(decisionMax).default(""),
  },
  returns: v.id("snapshots"),
  uses: [builder, addFigures, finish, map, statistics],
  handler: async (ctx, args) => {
    await ctx.runQuery(builder, {});
    const read: MapFigure[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: { items: MapFigure[]; nextCursor: string | null } =
        // oxlint-disable-next-line no-await-in-loop -- each page starts after the last
        await ctx.resources.map.call("figures.list", {
          pagination: { pageSize: mapPage, cursor },
        });
      // The map pages in an order no save changes; a workflow it answered
      // already is still never frozen twice.
      for (const item of page.items) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          read.push(item);
        }
      }
      // More than a snapshot holds: refused (freeze.ts) without reading on.
      if (read.length > figuresMax) {
        break;
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    const now = new Date();
    const frozen = await freeze(
      read,
      async (statisticQuery) =>
        await ctx.resources.statistics.read(statisticQuery),
      now.toISOString()
    );
    const takeId = crypto.randomUUID();
    const rows = frozen.figures.map((figure, at) => ({
      ...figure,
      take: takeId,
      at,
    }));
    // Each chunk of figures but the last in a commit of its own, and the
    // last with the snapshot.
    const lastFrom =
      rows.length === 0
        ? 0
        : Math.floor((rows.length - 1) / figuresPerWrite) * figuresPerWrite;
    for (let from = 0; from < lastFrom; from += figuresPerWrite) {
      // oxlint-disable-next-line no-await-in-loop -- one commit after another
      await ctx.runMutation(addFigures, {
        figures: rows.slice(from, from + figuresPerWrite),
      });
    }
    const date = now.toISOString().slice(0, 10);
    return await ctx.runMutation(finish, {
      last: rows.slice(lastFrom),
      take: takeId,
      title: `Snapshot ${date}`,
      date,
      maturity: args.maturity,
      windowDays,
      figures: rows.length,
      signals: frozen.signals,
      decisionNeeded: args.decisionNeeded,
    });
  },
});

/**
 * Saves a snapshot's narrative and the decision it asks for, at
 * `expectedRevision`: what it froze stays as it was taken.
 */
export const write = mutation({
  args: {
    id: v.id("snapshots"),
    expectedRevision: v.number().integer().min(1),
    decisionNeeded: v.string().trim().max(decisionMax),
    narrative: v.string().max(narrativeMax),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const stored = await ctx.db.get("snapshots", args.id);
    if (stored === null) {
      throw new AppError("board.not_found", "There's no such snapshot.");
    }
    await ctx.db.patch(
      "snapshots",
      args.id,
      { decisionNeeded: args.decisionNeeded, narrative: args.narrative },
      { expectedRevision: args.expectedRevision }
    );
    return null;
  },
});
