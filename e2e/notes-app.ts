import { appDefinition } from "../apps/core/test/app-definitions.ts";
import type { AppSpec } from "../apps/core/test/app-definitions.ts";

/**
 * The Notes App of spec 8 and 9.4, as a builder writes it: a schema, its
 * operations and registration, and a page on the React SDK
 * (`@grasp-os/sdk/react`) that reaches them only through the references
 * the host generates (`@server/_generated/api`).
 */

/** The Notes App's definition: its notes, and the files they attach. */
const notesSpec = {
  name: "Notes",
  tables: {
    notes: {
      fields: {
        title: "v.string().trim().min(1).max(200)",
        body: 'v.string().max(100_000).default("")',
        attachments: "v.array(v.file()).max(20).default([])",
      },
      access: { read: "owner", write: "owner" },
      indexes: { by_updated: ["_updatedAt"] },
    },
  },
  permissions: [
    'permission.files({ operations: ["upload", "read", "attach", "delete"] })',
  ],
} satisfies AppSpec;

const operations = `import { AppError, paginationOptionsValidator, paginationResultValidator, v } from "@grasp-os/sdk";
import { action, doc, internalMutation, mutation, query } from "@server/_generated/server";
import { internal } from "@server/_generated/internal";
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

/** Saves what someone changed of a note, and only that. */
export const update = mutation({
  args: {
    id: v.id("notes"),
    title: noteFields.title.optional(),
    body: v.string().max(100_000).optional(),
  },
  returns: doc("notes"),
  handler: async (ctx, { id, ...changed }) => {
    await ctx.db.patch("notes", id, changed);
    const updated = await ctx.db.get("notes", id);
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
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.notes.insert, { title: args.title });
    throw new AppError("import.stopped", "The import stopped halfway.");
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

/** Attaches an uploaded file to a note (spec 32.5). */
export const attachFile = mutation({
  args: { id: v.id("notes"), file: v.file() },
  returns: doc("notes"),
  handler: async (ctx, args) => {
    const note = await ctx.db.get("notes", args.id);
    if (!note) {
      throw new AppError("note.not_found", "The note is unavailable.");
    }
    if (note.attachments.some((file) => file.id === args.file.id)) {
      return note;
    }
    await ctx.db.patch("notes", args.id, { attachments: [...note.attachments, args.file] });
    const updated = await ctx.db.get("notes", args.id);
    if (!updated) {
      throw new AppError("note.not_found", "The note is unavailable.");
    }
    return updated;
  },
});

/** Takes a file off a note. */
export const detachFile = mutation({
  args: { id: v.id("notes"), file: v.file() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const note = await ctx.db.get("notes", args.id);
    if (!note) {
      throw new AppError("note.not_found", "The note is unavailable.");
    }
    await ctx.db.patch("notes", args.id, { attachments: note.attachments.filter((file) => file.id !== args.file.id) });
    return null;
  },
});
`;

const attachmentsList = `import { GraspError, useClient, useFile, useMutation, useUpload } from "@grasp-os/sdk/react";
import type { FileRef } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import { Label } from "@grasp-os/ui/components/label";
import { useState } from "react";
import { api, permissions } from "@server/_generated/api";
import type { Note } from "./note-editor.tsx";

/** One attached file: its preview, name and size, to download or remove. */
function Attachment({
  note,
  file,
  onOutcome,
}: {
  note: Note;
  file: FileRef;
  onOutcome: (outcome: string) => void;
}) {
  const shown = useFile(permissions.files, file);
  const client = useClient();
  const detach = useMutation(api.notes.detachFile);
  // Deleted: the row is gone too once the note's change reaches the list.
  if (shown === null) {
    return null;
  }
  if (shown === undefined) {
    return <li role="status">Loading the file…</li>;
  }
  const remove = async () => {
    try {
      await detach({ id: note._id, file });
    } catch (error) {
      onOutcome(\`Not removed: \${error instanceof GraspError ? error.message : "it failed"}\`);
      return;
    }
    try {
      await client.files.delete(permissions.files, file);
      onOutcome(\`Removed \${shown.name}.\`);
    } catch (error) {
      onOutcome(\`Removed from the note, not deleted: \${error instanceof GraspError ? error.message : "it failed"}\`);
    }
  };
  const download = async () => {
    try {
      await client.files.download(permissions.files, file);
    } catch (error) {
      onOutcome(\`Not downloaded: \${error instanceof GraspError ? error.message : "it failed"}\`);
    }
  };
  return (
    <li className="flex items-center gap-3">
      {shown.previewUrl === null ? null : (
        <img alt={\`Preview of \${shown.name}\`} className="size-12 rounded-md" src={shown.previewUrl} />
      )}
      <span>{shown.name}</span>
      <span>{shown.size} bytes</span>
      <Button
        onClick={() => void download()}
        variant="outline"
      >
        Download {shown.name}
      </Button>
      <Button onClick={() => void remove()} variant="outline">
        Remove {shown.name}
      </Button>
    </li>
  );
}

/**
 * A note's files: one uploaded at a time, then attached, each shown with
 * its preview.
 */
export function Attachments({ note }: { note: Note }) {
  const upload = useUpload(permissions.files);
  const attach = useMutation(api.notes.attachFile);
  const [outcome, setOutcome] = useState("");
  const send = async (picked: File) => {
    try {
      const file = await upload.upload(picked);
      await attach({ id: note._id, file });
      setOutcome(\`Attached \${picked.name}.\`);
    } catch (error) {
      setOutcome(error instanceof GraspError ? error.message : "The file couldn't be attached.");
    }
  };
  return (
    <section aria-label="Attachments" className="flex flex-col gap-3">
      <Label htmlFor="attachment">Attach a file</Label>
      <Input
        id="attachment"
        onChange={(event) => {
          const picked = event.currentTarget.files?.[0];
          if (picked !== undefined) {
            void send(picked);
          }
        }}
        type="file"
      />
      <output aria-label="Upload">{upload.status}</output>
      <output aria-label="Attaching">{outcome}</output>
      <ul aria-label="Attached files" className="flex flex-col gap-2">
        {note.attachments.map((file) => (
          <Attachment
            file={file}
            key={file.id}
            note={note}
            onOutcome={setOutcome}
          />
        ))}
      </ul>
    </section>
  );
}
`;

const createNote = `import { useForm } from "@grasp-os/sdk/react";
import { Form, FormError, SubmitButton, TextareaField, TextField } from "@grasp-os/ui/form";
import { api } from "@server/_generated/api";

/** A new note: the operation's input is the form, its contract the check. */
export function CreateNote() {
  const form = useForm(api.notes.create, {
    defaultValues: { title: "", body: "" },
    resetOnSuccess: true,
  });
  return (
    <Form aria-label="New note" form={form}>
      <TextField form={form} label="Title" name="title" />
      <TextareaField form={form} label="Body" name="body" />
      <FormError form={form} />
      <SubmitButton form={form}>Create note</SubmitButton>
    </Form>
  );
}
`;

const noteEditor = `import type { ReturnOf } from "@grasp-os/sdk";
import { useForm } from "@grasp-os/sdk/react";
import { Form, FormError, SubmitButton, TextareaField, TextField } from "@grasp-os/ui/form";
import { api } from "@server/_generated/api";

export type Note = NonNullable<ReturnOf<typeof api.notes.get>>;

/**
 * One note, edited with explicit Save: the form sends only the fields the
 * person changed, so someone else's save of the note's other field stays.
 * Saved, it opens again on the note it saved.
 */
export function NoteEditor({
  note,
  onSaved,
}: {
  note: Note;
  onSaved: (saved: Note) => void;
}) {
  const form = useForm(api.notes.update, {
    defaultValues: { id: note._id, title: note.title, body: note.body },
    onSuccess: onSaved,
  });
  return (
    <Form aria-label="Edit note" form={form}>
      <TextField form={form} label="Title" name="title" />
      <TextareaField form={form} label="Body" name="body" />
      <FormError form={form} />
      <SubmitButton form={form}>Save changes</SubmitButton>
    </Form>
  );
}
`;

const appPage = `import { createFileRoute } from "@tanstack/react-router";
import { useMutation, usePaginatedQuery, useQuery } from "@grasp-os/sdk/react";
import type { Id } from "@grasp-os/sdk";
import { Button } from "@grasp-os/ui/components/button";
import { useState } from "react";
import { api } from "@server/_generated/api";
import { Attachments } from "../components/attachments.tsx";
import { CreateNote } from "../components/create-note.tsx";
import { ImportNote } from "../components/import-note.tsx";
import { NoteEditor } from "../components/note-editor.tsx";
import type { Note } from "../components/note-editor.tsx";

/** The note chosen, loaded live; null is a note that is gone. */
function SelectedNote({ id }: { id: Id<"notes"> }) {
  const note = useQuery(api.notes.get, { id });
  // Saving opens the editor afresh: from the note it saved, or the note as
  // it is now, whichever is newer, as the live note may not have caught up
  // with a save yet.
  const [opened, setOpened] = useState<{ loads: number; saved: Note | null }>({
    loads: 0,
    saved: null,
  });
  if (note === undefined) {
    return <p role="status">Loading the note…</p>;
  }
  if (note === null) {
    return <p>This note is gone.</p>;
  }
  const { saved } = opened;
  const from = saved !== null && saved._updatedAt > note._updatedAt ? saved : note;
  // A note chosen anew is a new editor: what was typed never carries over.
  return (
    <>
      <NoteEditor
        key={\`\${note._id}:\${opened.loads}\`}
        note={from}
        onSaved={(next) => setOpened(({ loads }) => ({ loads: loads + 1, saved: next }))}
      />
      <Attachments note={note} />
    </>
  );
}

function Notes() {
  // A live list, five notes at a time: kept current as notes are saved,
  // edited and deleted anywhere, never with a note twice or missing.
  const { items, hasMore, isLoading, loadMore } = usePaginatedQuery(
    api.notes.list,
    {},
    { initialPageSize: 5 },
  );
  const remove = useMutation(api.notes.remove);
  const [selected, setSelected] = useState<Id<"notes"> | null>(null);

  if (isLoading && items.length === 0) {
    return <p role="status">Loading notes…</p>;
  }
  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Notes</h1>
      <CreateNote />
      <ImportNote />
      {items.length === 0 ? (
        <p>No notes yet.</p>
      ) : (
        <ul aria-label="Notes" className="flex flex-col gap-3">
          {items.map((note) => (
            <li className="flex items-center gap-3" key={note._id}>
              <span>{note.title}</span>
              <Button onClick={() => setSelected(note._id)} variant="outline">
                Edit {note.title}
              </Button>
              <Button
                onClick={() => void remove({ id: note._id })}
                variant="outline"
              >
                Delete {note.title}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {hasMore && (
        <Button disabled={isLoading} onClick={() => void loadMore()}>
          {isLoading ? "Loading…" : "Load more"}
        </Button>
      )}
      {/* A note chosen anew mounts afresh: nothing of the one before carries over. */}
      {selected === null ? null : <SelectedNote id={selected} key={selected} />}
    </main>
  );
}
export const Route = createFileRoute("/")({ component: Notes });
`;

const importNote = `import { GraspError, useAction } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { useState } from "react";
import { api } from "@server/_generated/api";

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
  ...appDefinition(notesSpec),
  "values.ts": `import { v } from "@grasp-os/sdk";

export const noteFields = {
  title: v.string().trim().min(1).max(200),
  body: v.string().max(100_000).default(""),
  attachments: v.array(v.file()).max(20).default([]),
};
`,
  "server/notes.ts": operations,
  "src/components/import-note.tsx": importNote,
  "src/components/create-note.tsx": createNote,
  "src/components/note-editor.tsx": noteEditor,
  "src/components/attachments.tsx": attachmentsList,
  "src/routes/index.tsx": appPage,
});

const unaskedPage = `import { createFileRoute } from "@tanstack/react-router";
import { GraspError, useClient } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { useEffect, useState } from "react";
import { permissions } from "@server/_generated/api";

/** A file nobody may read: what is downloaded matters less than whether. */
const someFile = { id: "00000000-0000-4000-8000-000000000000" };

/**
 * A page that downloads a file a while after it opens, without anyone
 * asking, and again on a click.
 */
function Notes() {
  const client = useClient();
  const [unasked, setUnasked] = useState("waiting");
  const [asked, setAsked] = useState("waiting");
  const download = async (onOutcome: (outcome: string) => void) => {
    try {
      await client.files.download(permissions.files, someFile);
      onOutcome("downloaded");
    } catch (error) {
      onOutcome(error instanceof GraspError ? error.code : "failed");
    }
  };
  useEffect(() => {
    // Later than any activation the page itself had (a navigation the
    // browser started counts as one, for a few seconds) can last.
    const timer = setTimeout(() => void download(setUnasked), 6000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <main className="flex flex-col gap-3 p-6">
      <h1 className="text-2xl font-semibold">Unasked</h1>
      <output aria-label="Unasked download">{unasked}</output>
      <Button onClick={() => void download(setAsked)}>Download</Button>
      <output aria-label="Asked download">{asked}</output>
    </main>
  );
}
export const Route = createFileRoute("/")({ component: Notes });
`;

const fileViewPage = `import { createFileRoute } from "@tanstack/react-router";
import { useClient, useFile, useUpload } from "@grasp-os/sdk/react";
import type { FileRef } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import { Label } from "@grasp-os/ui/components/label";
import { useState } from "react";
import { permissions } from "@server/_generated/api";

/** One file, or none while hidden. */
function Shown({
  file,
  hidden,
  renders,
}: {
  file: FileRef;
  hidden: boolean;
  renders: number;
}) {
  const shown = useFile(permissions.files, hidden ? "skip" : file);
  if (hidden) {
    return <p>The file is hidden</p>;
  }
  if (shown === null) {
    return <p>The file is gone</p>;
  }
  if (shown === undefined) {
    return <p role="status">Loading the file…</p>;
  }
  return (
    <p>
      Showing {shown.name}, rendered {renders} times
    </p>
  );
}

/** A file uploaded, then shown. */
function Notes() {
  const upload = useUpload(permissions.files);
  const client = useClient();
  const [file, setFile] = useState<FileRef | null>(null);
  const [hidden, setHidden] = useState(false);
  const [renders, setRenders] = useState(0);
  const [outcome, setOutcome] = useState("");
  const [deletion, setDeletion] = useState("");
  return (
    <main className="flex flex-col gap-3 p-6">
      <h1 className="text-2xl font-semibold">Files</h1>
      <Label htmlFor="picked">Upload a file</Label>
      <Input
        id="picked"
        onChange={(event) => {
          const picked = event.currentTarget.files?.[0];
          if (picked !== undefined) {
            upload.upload(picked).then(
              (uploaded) => {
                setFile((shown) => shown ?? uploaded);
              },
              (error: unknown) => {
                setOutcome(error instanceof Error ? error.message : "failed");
              }
            );
          }
        }}
        type="file"
      />
      <output aria-label="Upload">{outcome}</output>
      <Button onClick={() => setRenders((count) => count + 1)}>
        Render again
      </Button>
      <Button onClick={() => setHidden((was) => !was)}>
        {hidden ? "Show the file" : "Hide the file"}
      </Button>
      <Button
        onClick={() => {
          if (file !== null) {
            client.files.delete(permissions.files, file).then(
              () => {
                setDeletion("deleted");
              },
              (error: unknown) => {
                setDeletion(error instanceof Error ? error.message : "failed");
              }
            );
          }
        }}
      >
        Delete the file
      </Button>
      <output aria-label="Deletion">{deletion}</output>
      {file === null ? null : (
        <Shown
          file={file}
          hidden={hidden}
          renders={renders}
        />
      )}
    </main>
  );
}
export const Route = createFileRoute("/")({ component: Notes });
`;

/**
 * The Notes App with a page that shows an uploaded file, for what
 * `useFile` shows as it renders, hides and deletes it.
 */
export const fileViewFiles = (): Record<string, string> => ({
  ...notesAppFiles(),
  "src/routes/index.tsx": fileViewPage,
});

/**
 * The Notes App with a page that downloads unasked, for what a download
 * needs: a click.
 */
export const unaskedDownloadFiles = (): Record<string, string> => ({
  ...notesAppFiles(),
  "src/routes/index.tsx": unaskedPage,
});

const linksPage = `import { createFileRoute } from "@tanstack/react-router";
import { GraspError, useClient } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { useState } from "react";
import { permissions } from "@server/_generated/api";

/**
 * A page that opens its help site on a click, opens it a while after
 * the click (its activation spent), and tries a site it didn't declare.
 */
function Notes() {
  const client = useClient();
  const [outcome, setOutcome] = useState("waiting");
  const open = async (url: string) => {
    try {
      await client.links.open(permissions.links, { url });
      setOutcome("opened");
    } catch (error) {
      setOutcome(error instanceof GraspError ? error.code : "failed");
    }
  };
  return (
    <main className="flex flex-col gap-3 p-6">
      <h1 className="text-2xl font-semibold">Links</h1>
      <Button onClick={() => void open("https://help.example.com/guide")}>
        Open help
      </Button>
      <Button
        onClick={() => {
          setTimeout(() => void open("https://help.example.com/later"), 6000);
        }}
      >
        Open help later
      </Button>
      <Button onClick={() => void open("https://help.example.com.evil.test/")}>
        Open elsewhere
      </Button>
      <output aria-label="Link">{outcome}</output>
    </main>
  );
}
export const Route = createFileRoute("/")({ component: Notes });
`;

/**
 * The Notes App with a page that opens links through a help site it
 * declares, for what opening one needs: a click, or the person's say.
 */
export const linksFiles = (): Record<string, string> => ({
  ...notesAppFiles(),
  // The help site its pages may link to, and nothing else.
  ...appDefinition({
    ...notesSpec,
    permissions: [
      ...notesSpec.permissions,
      'permission.links({ origins: ["https://help.example.com"] })',
    ],
  }),
  "src/routes/index.tsx": linksPage,
});

/**
 * The Notes App with two more pages to move between: a start page that
 * links to a note, and the note's page at `/notes/$id`, which gets the
 * note's ID from its address, holds a form, and links back.
 */
export const navigationFiles = (): Record<string, string> => ({
  ...notesAppFiles(),
  "src/routes/start.tsx": `import { createFileRoute, Link } from "@tanstack/react-router";

function Start() {
  return (
    <main className="flex flex-col gap-3 p-6">
      <h1>Start</h1>
      <Link params={{ id: "n42" }} to="/notes/$id">Open note n42</Link>
    </main>
  );
}
export const Route = createFileRoute("/start")({ component: Start });
`,
  "src/routes/notes.$id.tsx": `import { createFileRoute, Link } from "@tanstack/react-router";
import { useForm } from "@grasp-os/sdk/react";
import { Form, TextField } from "@grasp-os/ui/form";
import { api } from "@server/_generated/api";

function Note() {
  const { id } = Route.useParams();
  const form = useForm(api.notes.create, { defaultValues: { title: "", body: "" } });
  return (
    <main className="flex flex-col gap-3 p-6">
      <h1>Note {id}</h1>
      <Form aria-label="Draft" form={form}>
        <TextField form={form} label="Title" name="title" />
      </Form>
      <Link to="/start">Back to start</Link>
    </main>
  );
}
export const Route = createFileRoute("/notes/$id")({ component: Note });
`,
});

/**
 * The navigation fixture with surfaces: the start page as a panel, the
 * list in the sidebar, and preferences as the App's settings.
 */
export const surfaceFiles = (): Record<string, string> => {
  const files = navigationFiles();
  return {
    ...files,
    "src/routes/index.tsx": `${files["src/routes/index.tsx"] ?? ""}
export const surface = { kind: "sidebar", title: "All notes" };
`,
    "src/routes/start.tsx": `${files["src/routes/start.tsx"] ?? ""}
export const surface = { kind: "panel", title: "Start beside" };
`,
    "src/routes/prefs.tsx": `import { createFileRoute } from "@tanstack/react-router";

function Prefs() {
  return (
    <main className="p-6">
      <h1>Preferences</h1>
    </main>
  );
}
export const Route = createFileRoute("/prefs")({ component: Prefs });
export const surface = { kind: "settings", title: "Options" };
`,
  };
};

/** A hop that opens the next as it mounts, up to `hopLimit`. */
const hopLimit = 5;

/**
 * The Notes App with pages that move the App without the person acting:
 * a start page that opens the first hop as it mounts, a launch page that
 * opens one on a click, and hops that each open the next as they mount,
 * plain, focusing themselves, or forging every sign of the person acting
 * they can.
 */
export const hoppingFiles = (): Record<string, string> => ({
  ...notesAppFiles(),
  "src/routes/takeoff.tsx": `import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

function Takeoff() {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({ to: "/hops/$n", params: { n: "1" } });
  }, [navigate]);
  return <main className="p-6"><h1>Takeoff</h1></main>;
}
export const Route = createFileRoute("/takeoff")({ component: Takeoff });
`,
  // A page that moves on a press and again on its release, and on a key's
  // first press and again on each of its repeats: one act each, the
  // press's, whatever the rest asks.
  "src/routes/keys.tsx": `import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "@grasp-os/ui/components/button";

function Keys() {
  const navigate = useNavigate();
  return (
    <main className="flex flex-col gap-3 p-6">
      <h1>Keys</h1>
      <Button
        onPointerDown={() => void navigate({ to: "/keys", hash: "down" })}
        onPointerUp={() => void navigate({ to: "/keys", hash: "up" })}
      >
        Press and lift
      </Button>
      <input
        aria-label="Keys"
        onKeyDown={(event) =>
          void navigate({ to: "/keys", hash: event.repeat ? "held" : "pressed" })
        }
      />
    </main>
  );
}
export const Route = createFileRoute("/keys")({ component: Keys });
`,
  "src/routes/launch.tsx": `import { createFileRoute, Link } from "@tanstack/react-router";

function Launch() {
  return (
    <main className="flex flex-col gap-3 p-6">
      <h1>Launch</h1>
      <Link params={{ n: "1" }} to="/hops/$n">Start hopping</Link>
      <Link params={{ n: "1" }} to="/focus-hops/$n">Start focused hopping</Link>
      <Link params={{ n: "1" }} to="/forges/$n">Start forging</Link>
    </main>
  );
}
export const Route = createFileRoute("/launch")({ component: Launch });
`,
  "src/routes/hops.$n.tsx": `import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

function Hop() {
  const { n } = Route.useParams();
  const navigate = useNavigate();
  useEffect(() => {
    if (Number(n) < ${hopLimit}) {
      void navigate({ to: "/hops/$n", params: { n: String(Number(n) + 1) } });
    }
  }, [navigate, n]);
  return <main className="p-6"><h1>Hop {n}</h1></main>;
}
export const Route = createFileRoute("/hops/$n")({ component: Hop });
`,
  // A hop that focuses its own field as it mounts, while the click that
  // opened the first is still active, so the page sees the person acting
  // in its frame, then navigates.
  "src/routes/focus-hops.$n.tsx": `import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

function FocusHop() {
  const { n } = Route.useParams();
  const navigate = useNavigate();
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
    if (Number(n) < ${hopLimit}) {
      void navigate({ to: "/focus-hops/$n", params: { n: String(Number(n) + 1) } });
    }
  }, [navigate, n]);
  return (
    <main className="p-6">
      <h1>Focus hop {n}</h1>
      <input aria-label="Where" ref={field} />
    </main>
  );
}
export const Route = createFileRoute("/focus-hops/$n")({ component: FocusHop });
`,
  // A hop that tries every way its code has to pass for the person
  // acting: it patches the prototypes the frame's document reports acts
  // with (dropping what an act report looks like), listens first to stop
  // input reaching anyone else, dispatches input of its own, posts
  // act-shaped messages to the page, and focuses itself, then navigates.
  // Its "Go back" link is the person's own act, which must still count.
  "src/routes/forges.$n.tsx": `import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

const forge = () => {
  const post = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (message, ...rest) {
    if (message === null) {
      return;
    }
    return Reflect.apply(post, this, [message, ...rest]);
  };
  for (const type of ["pointerdown", "pointerup", "mousedown", "keydown", "touchend"]) {
    window.addEventListener(type, (event) => event.stopImmediatePropagation(), true);
  }
  window.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
  parent.postMessage(null, "*");
  parent.postMessage({ type: "act" }, "*");
};

function Forge() {
  const { n } = Route.useParams();
  const navigate = useNavigate();
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    forge();
    field.current?.focus();
    if (Number(n) < ${hopLimit}) {
      void navigate({ to: "/forges/$n", params: { n: String(Number(n) + 1) } });
    }
  }, [navigate, n]);
  return (
    <main className="p-6">
      <h1>Forge {n}</h1>
      <input aria-label="Where" ref={field} />
      <Link to="/launch">Go back</Link>
    </main>
  );
}
export const Route = createFileRoute("/forges/$n")({ component: Forge });
`,
});
