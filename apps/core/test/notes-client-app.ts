import type { Id, OperationReference, ReferenceKind } from "@grasp-os/sdk";

import type { Release } from "../src/app-releases.ts";

// A Notes App on the accepted SDK, and its `api` as its screens import it
// from `#grasp`: what the session client's tests call, through a screen's
// page (screen-client.test.ts) or a portable host
// (portable-client.test.ts).

export const notesFiles: Record<string, string> = {
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export const noteFields = {
  title: v.string().trim().min(1).max(200),
  body: v.string().max(100_000).default(""),
};

export default defineSchema({
  notes: defineTable(noteFields).index("by_updated", ["_updatedAt"]),
});
`,
  "operations/notes.ts": `import { AppError, paginationOptionsValidator, paginationResultValidator, v } from "@grasp-os/sdk";
import { action, doc, mutation, query } from "#grasp/server";
import { noteFields } from "../schema.ts";

export const list = query({
  args: { pagination: paginationOptionsValidator },
  returns: paginationResultValidator(doc("notes")),
  handler: async (ctx, args) =>
    await ctx.db.query("notes").withIndex("by_updated").order("desc").paginate(args.pagination),
});

export const get = query({
  args: { id: v.id("notes") },
  returns: doc("notes").nullable(),
  handler: async (ctx, args) => await ctx.db.get("notes", args.id),
});

export const create = mutation({
  args: { title: noteFields.title, body: noteFields.body },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

export const update = mutation({
  args: {
    id: v.id("notes"),
    expectedRevision: v.number().integer().min(1),
    title: noteFields.title,
    body: v.string().max(100_000),
  },
  returns: doc("notes"),
  handler: async (ctx, args) => {
    await ctx.db.patch("notes", args.id, { title: args.title, body: args.body }, { expectedRevision: args.expectedRevision });
    const updated = await ctx.db.get("notes", args.id);
    if (!updated) {
      throw new AppError("note.not_found", "The note is unavailable.");
    }
    return updated;
  },
});

export const remove = mutation({
  args: { id: v.id("notes"), expectedRevision: v.number().integer().min(1) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.delete("notes", args.id, { expectedRevision: args.expectedRevision });
    return null;
  },
});

export const echo = action({
  args: { word: v.string().default("hello") },
  returns: v.string(),
  handler: async (_ctx, args) => args.word,
});

const pause = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

// Saves a note, and answers a token no second run would answer again.
export const stamp = action({
  args: {
    title: noteFields.title,
    pauseMs: v.number().integer().min(0).max(5000).default(0),
    // How long it takes after its save, before it answers.
    thenMs: v.number().integer().min(0).max(5000).default(0),
  },
  returns: v.object({ id: v.id("notes"), token: v.string() }),
  uses: [create],
  handler: async (ctx, args) => {
    await pause(args.pauseMs);
    const id = await ctx.runMutation(create, { title: args.title, body: "" });
    await pause(args.thenMs);
    return { id, token: crypto.randomUUID() };
  },
});

// Answers as much as an operation may, which leaves no room for the rest
// of a screen's answer.
export const big = action({
  args: {},
  returns: v.string(),
  handler: async () => "x".repeat(262_084),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { big, create, echo, get, list, remove, stamp, update } from "./operations/notes.ts";
import schema from "./schema.ts";

export default app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { notes: { list, get, create, update, remove, echo, stamp, big } },
  internalOperations: {},
  screens: [],
  uses: [],
});
`,
  "screens/notes.tsx": `import { useMutation, useQuery } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { api } from "#grasp";

export default function Notes() {
  const notes = useQuery(api.notes.list, { pagination: { pageSize: 50 } });
  const create = useMutation(api.notes.create);
  if (notes === undefined) {
    return <p role="status">Loading notes…</p>;
  }
  return (
    <main className="flex flex-col gap-3 p-6">
      <ul>
        {notes.items.map((note) => (
          <li key={note._id}>{note.title}</li>
        ))}
      </ul>
      <Button onClick={() => void create({ title: "New note" })}>Add</Button>
    </main>
  );
}
`,
};

/** A note as the App's queries return it. */
export interface Note {
  _id: Id<"notes">;
  _rev: number;
  _createdAt: number;
  _updatedAt: number;
  _ownerId: string;
  title: string;
  body: string;
}

export type Page =
  | { items: Note[]; hasMore: false; nextCursor: null }
  | { items: Note[]; hasMore: true; nextCursor: string };

/** The reference to `path` of `release`, typed as the App's `#grasp` types it. */
export const referenceTo = <Args, Return, Kind extends ReferenceKind>(
  release: Release,
  path: string
): OperationReference<Args, Return, Kind> => {
  const operation = release.app.operations[path];
  const fingerprint = release.fingerprints[path];
  if (operation === undefined || fingerprint === undefined) {
    throw new Error(`The release has no ${path}`);
  }
  // The same data the host generates into `#grasp` for this release (sdk
  // generate.ts), typed by hand as it would be.
  return {
    resourceId: release.manifest.resourceId,
    resourceVersion: release.manifest.resourceVersion,
    contractId: path,
    fingerprint,
    // SAFETY: each call below names the kind the release declares.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    kind: operation.kind as Kind,
    visibility: "public",
    mode: "single",
    args: operation.args,
    returns: operation.returns,
  };
};

/** The App's `api`, as its screens import it from `#grasp`. */
export const apiOf = (release: Release) => ({
  list: referenceTo<
    { pagination: { cursor?: string | null; pageSize?: number } },
    Page,
    "query"
  >(release, "notes.list"),
  get: referenceTo<{ id: Id<"notes"> }, Note | null, "query">(
    release,
    "notes.get"
  ),
  create: referenceTo<
    { title: string; body?: string },
    Id<"notes">,
    "mutation"
  >(release, "notes.create"),
  update: referenceTo<
    { id: Id<"notes">; expectedRevision: number; title: string; body: string },
    Note,
    "mutation"
  >(release, "notes.update"),
  remove: referenceTo<
    { id: Id<"notes">; expectedRevision: number },
    null,
    "mutation"
  >(release, "notes.remove"),
  echo: referenceTo<{ word?: string }, string, "action">(release, "notes.echo"),
  stamp: referenceTo<
    { title: string; pauseMs?: number; thenMs?: number },
    { id: Id<"notes">; token: string },
    "action"
  >(release, "notes.stamp"),
  big: referenceTo<Record<never, never>, string, "action">(
    release,
    "notes.big"
  ),
});
