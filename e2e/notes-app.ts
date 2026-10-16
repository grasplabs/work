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
  attachments: v.array(v.file()).max(20).default([]),
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

/** Attaches an uploaded file to a note, at the revision it was read (spec 32.5). */
export const attachFile = mutation({
  args: { id: v.id("notes"), expectedRevision: v.number().integer().min(1), file: v.file() },
  returns: doc("notes"),
  handler: async (ctx, args) => {
    const note = await ctx.db.get("notes", args.id, { expectedRevision: args.expectedRevision });
    if (!note) {
      throw new AppError("note.not_found", "The note is unavailable.");
    }
    if (note.attachments.some((file) => file.id === args.file.id)) {
      return note;
    }
    await ctx.db.patch("notes", args.id, { attachments: [...note.attachments, args.file] }, { expectedRevision: args.expectedRevision });
    const updated = await ctx.db.get("notes", args.id);
    if (!updated) {
      throw new AppError("note.not_found", "The note is unavailable.");
    }
    return updated;
  },
});

/** Takes a file off a note, at the revision it was read. */
export const detachFile = mutation({
  args: { id: v.id("notes"), expectedRevision: v.number().integer().min(1), file: v.file() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const note = await ctx.db.get("notes", args.id, { expectedRevision: args.expectedRevision });
    if (!note) {
      throw new AppError("note.not_found", "The note is unavailable.");
    }
    await ctx.db.patch("notes", args.id, { attachments: note.attachments.filter((file) => file.id !== args.file.id) }, { expectedRevision: args.expectedRevision });
    return null;
  },
});
`;

const registration = `import { app, resource } from "@grasp-os/sdk";
import { attachFile, create, detachFile, get, importHalfway, insert, list, remove, update } from "./operations/notes.ts";
import schema from "./schema.ts";

export const attachments = resource.files("attachments", {
  operations: ["upload", "read", "attach", "delete"],
});

/** Files read through another resource: the same files, nothing else. */
export const photos = resource.files("photos", { operations: ["read"] });

export default app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { notes: { list, get, create, update, remove, importHalfway, attachFile, detachFile } },
  internalOperations: { notes: { insert } },
  screens: [{ name: "notes", path: "/", source: "screens/notes.tsx" }],
  uses: [attachments, photos],
});
`;

const attachmentsList = `import { GraspError, useClient, useFile, useMutation, useUpload } from "@grasp-os/sdk/react";
import type { FileRef } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import { Label } from "@grasp-os/ui/components/label";
import { useState } from "react";
import { api, resources } from "#grasp";
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
  const shown = useFile(resources.attachments, file);
  const client = useClient();
  const detach = useMutation(api.notes.detachFile);
  if (shown === undefined) {
    return <li role="status">Loading the file…</li>;
  }
  const remove = async () => {
    try {
      await detach({ id: note._id, expectedRevision: note._rev, file });
    } catch (error) {
      onOutcome(\`Not removed: \${error instanceof GraspError ? error.message : "it failed"}\`);
      return;
    }
    try {
      await client.files.delete(resources.attachments, file);
      onOutcome(\`Removed \${shown.name}.\`);
    } catch (error) {
      onOutcome(\`Removed from the note, not deleted: \${error instanceof GraspError ? error.message : "it failed"}\`);
    }
  };
  const download = async () => {
    try {
      await client.files.download(resources.attachments, file);
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
 * A note's files: one uploaded at a time, then attached at the revision
 * the note was read, each shown with its preview.
 */
export function Attachments({ note }: { note: Note }) {
  const upload = useUpload(resources.attachments);
  const attach = useMutation(api.notes.attachFile);
  const [outcome, setOutcome] = useState("");
  const send = async (picked: File) => {
    try {
      const file = await upload.upload(picked);
      await attach({ id: note._id, expectedRevision: note._rev, file });
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
import { api } from "#grasp";

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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import { Form, FormChanges, FormError, SubmitButton, TextareaField, TextField } from "@grasp-os/ui/form";
import { useState } from "react";
import { api } from "#grasp";

export type Note = NonNullable<ReturnOf<typeof api.notes.get>>;

/**
 * One note, edited with explicit Save: the draft keeps the revision it
 * started from, and a save someone else's overtook keeps the draft until
 * the person chooses to load the latest version, or to re-apply their
 * changes on it. The draft outlives the editor and a refresh of the page.
 */
export function NoteEditor({ note }: { note: Note }) {
  const form = useForm(api.notes.update, {
    record: note,
    fields: ["title", "body"],
    args: (baseline) => ({ id: baseline._id, expectedRevision: baseline._rev }),
  });
  const [confirming, setConfirming] = useState(false);
  return (
    <Form aria-label="Edit note" form={form}>
      <TextField form={form} label="Title" name="title" />
      <TextareaField form={form} label="Body" name="body" />
      <FormError form={form} />
      <FormChanges form={form} labels={{ title: "Title", body: "Body" }} />
      <div className="flex gap-2">
        <SubmitButton form={form}>Save changes</SubmitButton>
        <AlertDialog onOpenChange={setConfirming} open={confirming}>
          <AlertDialogTrigger render={<Button variant="outline" />}>
            Load the latest version
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Discard your changes?</AlertDialogTitle>
              <AlertDialogDescription>
                What you changed in this note and haven't saved is lost, and its latest version shows instead.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  form.reload();
                  setConfirming(false);
                }}
                variant="destructive"
              >
                Discard and load
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </Form>
  );
}
`;

const screen = `import { useMutation, usePaginatedQuery, useQuery } from "@grasp-os/sdk/react";
import type { Id } from "@grasp-os/sdk";
import { Button } from "@grasp-os/ui/components/button";
import { useState } from "react";
import { api } from "#grasp";
import { Attachments } from "../components/attachments.tsx";
import { CreateNote } from "../components/create-note.tsx";
import { ImportNote } from "../components/import-note.tsx";
import { NoteEditor } from "../components/note-editor.tsx";

/** The note chosen, loaded live; null is a note that is gone. */
function SelectedNote({ id }: { id: Id<"notes"> }) {
  const note = useQuery(api.notes.get, { id });
  if (note === undefined) {
    return <p role="status">Loading the note…</p>;
  }
  if (note === null) {
    return <p>This note is gone.</p>;
  }
  // A note chosen anew is a new editor: its draft never carries over.
  return (
    <>
      <NoteEditor key={note._id} note={note} />
      <Attachments note={note} />
    </>
  );
}

export default function Notes() {
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
                onClick={() => void remove({ id: note._id, expectedRevision: note._rev })}
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
      {selected === null ? null : <SelectedNote id={selected} />}
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
  "components/create-note.tsx": createNote,
  "components/note-editor.tsx": noteEditor,
  "components/attachments.tsx": attachmentsList,
  "screens/notes.tsx": screen,
});

const unaskedScreen = `import { GraspError, useClient } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { useEffect, useState } from "react";
import { resources } from "#grasp";

/** A file nobody may read: what is downloaded matters less than whether. */
const someFile = { id: "00000000-0000-4000-8000-000000000000" };

/**
 * A screen that downloads a file a while after it opens, without anyone
 * asking, and again on a click.
 */
export default function Notes() {
  const client = useClient();
  const [unasked, setUnasked] = useState("waiting");
  const [asked, setAsked] = useState("waiting");
  const download = async (onOutcome: (outcome: string) => void) => {
    try {
      await client.files.download(resources.attachments, someFile);
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
`;

const fileViewScreen = `import { useFile, useUpload } from "@grasp-os/sdk/react";
import type { FileRef } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import { Label } from "@grasp-os/ui/components/label";
import { useState } from "react";
import { resources } from "#grasp";

/** One file, through the resource chosen, or none while hidden. */
function Shown({
  file,
  viaPhotos,
  hidden,
  renders,
}: {
  file: FileRef;
  viaPhotos: boolean;
  hidden: boolean;
  renders: number;
}) {
  const shown = useFile(
    viaPhotos ? resources.photos : resources.attachments,
    hidden ? "skip" : file
  );
  if (hidden) {
    return <p>The file is hidden</p>;
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

/** A file uploaded, then shown through one resource or the other. */
export default function Notes() {
  const upload = useUpload(resources.attachments);
  const [file, setFile] = useState<FileRef | null>(null);
  const [viaPhotos, setViaPhotos] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [renders, setRenders] = useState(0);
  const [outcome, setOutcome] = useState("");
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
      <Button onClick={() => setViaPhotos(true)}>Through photos</Button>
      <Button onClick={() => setRenders((count) => count + 1)}>
        Render again
      </Button>
      <Button onClick={() => setHidden((was) => !was)}>
        {hidden ? "Show the file" : "Hide the file"}
      </Button>
      {file === null ? null : (
        <Shown
          file={file}
          viaPhotos={viaPhotos}
          hidden={hidden}
          renders={renders}
        />
      )}
    </main>
  );
}
`;

/**
 * The Notes App with a screen that shows an uploaded file through one
 * resource or another, for what `useFile` shows when either changes.
 */
export const fileViewFiles = (): Record<string, string> => ({
  ...notesAppFiles(),
  "screens/notes.tsx": fileViewScreen,
});

/**
 * The Notes App with a screen that downloads unasked, for what a download
 * needs: a click.
 */
export const unaskedDownloadFiles = (): Record<string, string> => ({
  ...notesAppFiles(),
  "screens/notes.tsx": unaskedScreen,
});
