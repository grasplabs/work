import type {
  Id,
  FunctionReference,
  ReferenceKind,
} from "@grasp-os/runtime/app";

import type { Release } from "../src/app-releases.ts";
import { testApp, withoutDefinition } from "./app-definitions.ts";
import type { AppSpec, TestApp } from "./app-definitions.ts";

// A Notes App on the accepted SDK, and its `api` as its pages import it
// from `@server/_generated/api`: what the session client's tests call,
// through a page's page (page-client*.test.ts).

/** The Notes App's definition: its notes, which each person keeps their own. */
export const notesSpec = {
  name: "Notes",
  tables: {
    notes: {
      fields: {
        title: "v.string().trim().min(1).max(200)",
        body: 'v.string().max(100_000).default("")',
      },
      access: { read: "owner", write: "owner" },
      indexes: { by_updated: ["_updatedAt"] },
    },
  },
} satisfies AppSpec;

export const notesFiles: TestApp = testApp(notesSpec, {
  "values.ts": `import { v } from "@grasp-os/sdk";

export const noteFields = {
  title: v.string().trim().min(1).max(200),
  body: v.string().max(100_000).default(""),
};
`,
  "server/notes.ts": `import { AppError, paginationOptionsValidator, paginationResultValidator, v } from "@grasp-os/sdk";
import { action, doc, mutation, query } from "@server/_generated/server";
import { noteFields } from "../values.ts";

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
    title: noteFields.title,
    body: v.string().max(100_000),
  },
  returns: doc("notes"),
  handler: async (ctx, args) => {
    await ctx.db.patch("notes", args.id, { title: args.title, body: args.body });
    const updated = await ctx.db.get("notes", args.id);
    if (!updated) {
      throw new AppError("note.not_found", "The note is unavailable.");
    }
    return updated;
  },
});

export const remove = mutation({
  args: { id: v.id("notes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.delete("notes", args.id);
    return null;
  },
});

export const echo = action({
  args: { word: v.string().default("hello") },
  returns: v.string(),
  handler: (_ctx, args) => args.word,
});

const pause = async (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(resolve, ms);
  await promise;
};

// Saves a note, and answers a token no second run would answer again.
export const stamp = action({
  args: {
    title: noteFields.title,
    pauseMs: v.number().integer().min(0).max(5000).default(0),
    // Once saved, it answers only once a read of its note is refused
    // because its release was revoked: the caller's signal, not a time to
    // race. Half a second apart, its reads last until an action's 30 s
    // deadline at most; that, or any other refusal, fails it.
    untilRevoked: v.boolean().default(false),
  },
  returns: v.object({ id: v.id("notes"), token: v.string() }),
  handler: async (ctx, args) => {
    await pause(args.pauseMs);
    const id = await ctx.runMutation(create, { title: args.title, body: "" });
    if (args.untilRevoked) {
      try {
        for (;;) {
          // oxlint-disable-next-line no-await-in-loop -- one read after the other
          await ctx.runQuery(get, { id });
          // oxlint-disable-next-line no-await-in-loop -- half a second apart
          await pause(500);
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "version.revoked")) {
          throw error;
        }
      }
    }
    return { id, token: crypto.randomUUID() };
  },
});

// Answers as much as a function may, which leaves no room for the rest
// of a page's answer.
export const big = action({
  args: {},
  returns: v.string(),
  handler: () => "x".repeat(262_084),
});
`,

  "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { api } from "@server/_generated/api";

const Notes = () => {
  const notes = useQuery(api.notes.list, { pagination: { pageSize: 50 } });
  const create = useMutation(api.notes.create);
  const handleAdd = async () => {
    await create({ title: "New note" });
  };
  if (notes === undefined) {
    return <output>Loading notes…</output>;
  }
  return (
    <main className="flex flex-col gap-3 p-6">
      <ul>
        {notes.items.map((note) => (
          <li key={note._id}>{note.title}</li>
        ))}
      </ul>
      <Button onClick={handleAdd}>Add</Button>
    </main>
  );
};

export const Route = createFileRoute("/")({ component: Notes });
`,
});

/** The Notes App's definition, as the chat's definition tools make it. */
export const notesDefinition = [
  {
    op: "addTable",
    name: "notes",
    fields: {
      title: "v.string().trim().min(1).max(200)",
      body: 'v.string().max(100_000).default("")',
    },
    access: { read: "owner", write: "owner" },
  },
  {
    op: "addIndex",
    table: "notes",
    name: "by_updated",
    fields: ["_updatedAt"],
  },
] as const;

/**
 * What a run's code calls to give `app`'s draft the Notes definition, as
 * the chat's agent does with its definition tools.
 */
export const defineNotes = `for (const operation of ${JSON.stringify(notesDefinition)}) {
  const defined = await env.build.define(app.id, operation);
  if (!defined.ok) throw new Error(defined.problem);
}`;

/**
 * The Notes App's code, as the chat's agent writes it beside its
 * definition (`notesDefinition`): the definition's config and schema are
 * generated, so its fields' validators are its own values.
 */
export const notesCode: Record<string, string> = {
  "values.ts": `import { v } from "@grasp-os/sdk";

export const noteFields = {
  title: v.string().trim().min(1).max(200),
  body: v.string().max(100_000).default(""),
};
`,
  ...Object.fromEntries(
    Object.entries(withoutDefinition(notesFiles)).map(([path, text]) => [
      path,
      text.replace('from "./schema.ts";', 'from "../values.ts";'),
    ])
  ),
};

/** A note as the App's queries return it. */
export interface Note {
  _id: Id<"notes">;
  _createdAt: number;
  _updatedAt: number;
  _ownerId: string;
  title: string;
  body: string;
}

export type Page =
  | { items: Note[]; hasMore: false; nextCursor: null }
  | { items: Note[]; hasMore: true; nextCursor: string };

/**
 * The reference to `path` of `release`, as the App's
 * `@server/_generated/api` holds it: its name. Typed by hand, as that
 * module types it.
 */
export const referenceTo = <
  Args,
  Return,
  Kind extends ReferenceKind,
  Progress = never,
>(
  release: Release,
  path: string
): FunctionReference<Kind, "public", Args, Return, Progress> => {
  const fn = release.app.functions[path];
  if (fn === undefined) {
    throw new Error(`The release has no ${path}`);
  }
  // Each caller names the kind, arguments, return and progress the
  // release declares.
  return { name: fn.path };
};

/** The App's `api`, as its pages import it from `@server/_generated/api`. */
export const apiOf = (release: Release) => ({
  list: referenceTo<
    {
      pagination: {
        cursor?: string | null;
        endCursor?: string | null;
        pageSize?: number;
      };
    },
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
    { id: Id<"notes">; title: string; body: string },
    Note,
    "mutation"
  >(release, "notes.update"),
  remove: referenceTo<{ id: Id<"notes"> }, null, "mutation">(
    release,
    "notes.remove"
  ),
  echo: referenceTo<{ word?: string }, string, "action">(release, "notes.echo"),
  stamp: referenceTo<
    { title: string; pauseMs?: number; untilRevoked?: boolean },
    { id: Id<"notes">; token: string },
    "action"
  >(release, "notes.stamp"),
  big: referenceTo<Record<never, never>, string, "action">(
    release,
    "notes.big"
  ),
});
