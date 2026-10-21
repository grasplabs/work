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
  // Deleted: the row is gone too once the note's change reaches the list.
  if (shown === null) {
    return null;
  }
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

const fileViewScreen = `import { useClient, useFile, useUpload } from "@grasp-os/sdk/react";
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

/** A file uploaded, then shown through one resource or the other. */
export default function Notes() {
  const upload = useUpload(resources.attachments);
  const client = useClient();
  const [file, setFile] = useState<FileRef | null>(null);
  const [viaPhotos, setViaPhotos] = useState(false);
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
      <Button onClick={() => setViaPhotos(true)}>Through photos</Button>
      <Button onClick={() => setRenders((count) => count + 1)}>
        Render again
      </Button>
      <Button onClick={() => setHidden((was) => !was)}>
        {hidden ? "Show the file" : "Hide the file"}
      </Button>
      <Button
        onClick={() => {
          if (file !== null) {
            client.files.delete(resources.attachments, file).then(
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

/**
 * The Notes App with two more screens to move between (spec 10.7.7): a
 * start screen that opens a note by its route, and the note's screen,
 * which gets the note's ID as its route input, holds a form, and goes back.
 */
export const navigationFiles = (): Record<string, string> => ({
  ...notesAppFiles(),
  "app.ts": registration
    .replace(
      'import { app, resource } from "@grasp-os/sdk";',
      'import { app, resource, v } from "@grasp-os/sdk";'
    )
    .replace(
      '  screens: [{ name: "notes", path: "/", source: "screens/notes.tsx" }],',
      `  screens: [
    { name: "notes", path: "/", source: "screens/notes.tsx" },
    { name: "start", path: "/start", source: "screens/home.tsx" },
    { name: "note", path: "/notes/:id", source: "screens/note.tsx", input: v.object({ id: v.string() }) },
  ],`
    ),
  "screens/home.tsx": `import { useNavigate } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { screens } from "#grasp";

export default function Start() {
  const navigate = useNavigate();
  return (
    <main className="flex flex-col gap-3 p-6">
      <h1>Start</h1>
      <Button onClick={() => void navigate(screens.note, { id: "n42" })}>Open note n42</Button>
      <Button onClick={() => void navigate(screens.note, { id: "n42" }, { replace: true })}>Open note n42 in place</Button>
    </main>
  );
}
`,
  "screens/note.tsx": `import { useState } from "react";
import { useForm, useNavigate } from "@grasp-os/sdk/react";
import type { ScreenProps } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { Form, TextField } from "@grasp-os/ui/form";
import { api, screens } from "#grasp";

export default function Note({ input }: ScreenProps<typeof screens.note>) {
  const navigate = useNavigate();
  const [refused, setRefused] = useState(0);
  const form = useForm(api.notes.create, { defaultValues: { title: "", body: "" } });
  return (
    <main className="flex flex-col gap-3 p-6">
      <h1>Note {input.id}</h1>
      <Form aria-label="Draft" form={form}>
        <TextField form={form} label="Title" name="title" />
      </Form>
      <Button onClick={() => void navigate(screens.start).catch(() => setRefused((count) => count + 1))}>Back to start</Button>
      <Button onClick={() => void navigate(screens.note, { id: input.id }).catch(() => setRefused((count) => count + 1))}>Open this note again</Button>
      <p>Refused {refused}</p>
    </main>
  );
}
`,
});

/**
 * The navigation fixture with surfaces (spec 34.1): the start screen as a
 * panel (named to list after the note's panel, which needs input, so the
 * chat's side panel must pass that one over) and the App's settings, the note as a panel and a deep link, and
 * the list in the sidebar. The start screen also opens the note's panel.
 */
export const surfaceFiles = (): Record<string, string> => {
  const files = navigationFiles();
  return {
    ...files,
    "app.ts": (files["app.ts"] ?? "").replace(
      "input: v.object({ id: v.string() }) },\n  ],\n",
      `input: v.object({ id: v.string() }) },
    { name: "prefs", path: "/prefs", source: "screens/prefs.tsx", input: v.object({ section: v.enum(["general", "billing"]).default("general") }) },
  ],
  surfaces: [
    { name: "start", kind: "panel", screen: "start", title: "Start beside", input: v.object({}) },
    { name: "peek", kind: "panel", screen: "note", title: "Peek", input: v.object({ id: v.string() }) },
    { name: "all", kind: "sidebar", screen: "notes", title: "All notes", input: v.object({}) },
    { name: "prefs", kind: "settings", screen: "prefs", title: "Preferences", input: v.object({ section: v.enum(["general", "billing"]).default("general") }) },
    { name: "shared", kind: "deepLink", screen: "note", title: "Shared note", input: v.object({ id: v.string() }) },
  ],
`
    ),
    "screens/prefs.tsx": `import type { ScreenProps } from "@grasp-os/sdk/react";
import type { screens } from "#grasp";

export default function Prefs({ input }: ScreenProps<typeof screens.prefs>) {
  return (
    <main className="p-6">
      <h1>Preferences {input.section}</h1>
    </main>
  );
}
`,
    "screens/home.tsx": (files["screens/home.tsx"] ?? "")
      .replace(
        'import { screens } from "#grasp";',
        'import { screens } from "#grasp";\nimport { useState } from "react";'
      )
      .replace(
        "  const navigate = useNavigate();",
        '  const navigate = useNavigate();\n  const [peek, setPeek] = useState("Peek not asked");'
      )
      .replace(
        "    </main>",
        `      <Button onClick={() => void navigate(screens.note, { id: "n9" }, { surface: "peek" }).then(() => setPeek("Peek opened"), () => setPeek("Peek refused"))}>Peek at note n9</Button>
      <p>{peek}</p>
      <Button onClick={() => void navigate(screens.prefs, {}, { surface: "prefs" })}>Open preferences</Button>
      <Button onClick={() => void navigate(screens.prefs, { section: "billing" }, { surface: "prefs" })}>Open billing preferences</Button>
      <Button onClick={() => { setTimeout(() => { void navigate(screens.note, { id: "n77" }); }, 1500); }}>Open note n77 later</Button>
      <Button onClick={() => { setTimeout(() => { void navigate(screens.notes); }, 1500); }}>Open the list later</Button>
    </main>`
      ),
  };
};

/**
 * The Notes App with screens that navigate without the person acting
 * (spec 10.7.7): a start screen that opens the first hop as it mounts, a
 * launch screen that opens it on a click, and a hop screen that opens the
 * next one each time it starts.
 */
export const hoppingFiles = (): Record<string, string> => ({
  ...notesAppFiles(),
  "app.ts": registration
    .replace(
      'import { app, resource } from "@grasp-os/sdk";',
      'import { app, resource, v } from "@grasp-os/sdk";'
    )
    .replace(
      '  screens: [{ name: "notes", path: "/", source: "screens/notes.tsx" }],',
      `  screens: [
    { name: "notes", path: "/", source: "screens/notes.tsx" },
    { name: "start", path: "/start", source: "screens/takeoff.tsx" },
    { name: "launch", path: "/launch", source: "screens/launch.tsx" },
    { name: "hop", path: "/hops/:n", source: "screens/hop.tsx", input: v.object({ n: v.string() }) },
  ],`
    ),
  "screens/takeoff.tsx": `import { useEffect } from "react";
import { useNavigate } from "@grasp-os/sdk/react";
import { screens } from "#grasp";

export default function Takeoff() {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate(screens.hop, { n: "1" }).catch(() => undefined);
  }, [navigate]);
  return <main className="p-6"><h1>Takeoff</h1></main>;
}
`,
  "screens/launch.tsx": `import { useNavigate } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { screens } from "#grasp";

export default function Launch() {
  const navigate = useNavigate();
  return (
    <main className="p-6">
      <h1>Launch</h1>
      <Button onClick={() => void navigate(screens.hop, { n: "1" })}>Start hopping</Button>
    </main>
  );
}
`,
  "screens/hop.tsx": `import { useEffect } from "react";
import { useNavigate } from "@grasp-os/sdk/react";
import type { ScreenProps } from "@grasp-os/sdk/react";
import { screens } from "#grasp";

export default function Hop({ input }: ScreenProps<typeof screens.hop>) {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate(screens.hop, { n: String(Number(input.n) + 1) }).catch(() => undefined);
  }, [navigate, input.n]);
  return <main className="p-6"><h1>Hop {input.n}</h1></main>;
}
`,
});
