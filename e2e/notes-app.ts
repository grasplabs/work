/**
 * The Notes App of spec 8 and 9.4, as a builder writes it: a schema, its
 * operations and registration, and a screen on the React SDK
 * (`@grasp-os/sdk/react`) that reaches them only through the references
 * the host generates (`#grasp`).
 */

const schema = `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export const noteFields = {
  title: v.string().trim().min(1).max(200),
  body: v.string().max(100_000).default(""),
};

export default defineSchema({
  notes: defineTable(noteFields).index("by_updated", ["_updatedAt"]),
});
`;

const operations = `import { AppError, paginationOptionsValidator, paginationResultValidator, v } from "@grasp-os/sdk";
import { action, doc, internalMutation, mutation, query } from "#grasp/server";
import { internal } from "#grasp/server-references";
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

/** Saves a note for an action: the App's own code only. */
export const insert = internalMutation({
  args: { title: noteFields.title },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

/**
 * Imports a note and then fails: the note it saved stays saved, as an
 * action's mutations commit each on its own.
 */
export const importHalfway = action({
  args: { title: noteFields.title },
  returns: v.null(),
  uses: [internal.notes.insert],
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.notes.insert, { title: args.title });
    throw new AppError("import.stopped", "The import stopped halfway.");
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
`;

const registration = `import { app } from "@grasp-os/sdk";
import { create, get, importHalfway, insert, list, remove, update } from "./operations/notes.ts";
import schema from "./schema.ts";

export default app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { notes: { list, get, create, update, remove, importHalfway } },
  internalOperations: { notes: { insert } },
  screens: [{ name: "notes", path: "/", source: "screens/notes.tsx" }],
  uses: [],
});
`;

const screen = `import { useMutation, useQuery } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import { Label } from "@grasp-os/ui/components/label";
import { useState } from "react";
import type { MouseEvent } from "react";
import { api } from "#grasp";
import { ImportNote } from "../components/import-note.tsx";

export default function Notes() {
  const notes = useQuery(api.notes.list, { pagination: { pageSize: 50 } });
  const create = useMutation(api.notes.create);
  const remove = useMutation(api.notes.remove);
  const [title, setTitle] = useState("");

  // The frame's sandbox submits no form, so the button (which Enter in the
  // field clicks too) creates the note itself.
  const submit = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    await create({ title });
    setTitle("");
  };

  if (notes === undefined) {
    return <p role="status">Loading notes…</p>;
  }
  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Notes</h1>
      <form className="flex items-end gap-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="title">Title</Label>
          <Input id="title" onChange={(event) => setTitle(event.target.value)} value={title} />
        </div>
        <Button onClick={(event) => void submit(event)} type="submit">
          Create note
        </Button>
      </form>
      <ImportNote />
      {notes.items.length === 0 ? (
        <p>No notes yet.</p>
      ) : (
        <ul aria-label="Notes" className="flex flex-col gap-3">
          {notes.items.map((note) => (
            <li className="flex items-center gap-3" key={note._id}>
              <span>{note.title}</span>
              <Button
                onClick={() => void remove({ id: note._id, expectedRevision: note._rev })}
                variant="outline"
              >
                Delete {note.title}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
`;

const importNote = `import { GraspError, useAction } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { useState } from "react";
import { api } from "#grasp";

/** Imports a note through an action that fails after saving it. */
export function ImportNote() {
  const importHalfway = useAction(api.notes.importHalfway);
  const [outcome, setOutcome] = useState("");
  const run = async () => {
    try {
      await importHalfway({ title: "Imported" });
      setOutcome("Imported.");
    } catch (error) {
      setOutcome(error instanceof GraspError ? error.message : "It failed.");
    }
  };
  return (
    <div className="flex items-center gap-3">
      <Button onClick={() => void run()} variant="outline">
        Import a note
      </Button>
      <output aria-label="Import">{outcome}</output>
    </div>
  );
}
`;

/** The Notes App's files. */
export const notesAppFiles = (): Record<string, string> => ({
  "schema.ts": schema,
  "operations/notes.ts": operations,
  "app.ts": registration,
  "components/import-note.tsx": importNote,
  "screens/notes.tsx": screen,
});
