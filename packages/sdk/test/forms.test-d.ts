// Compile-time guarantees of `useForm` (spec 10.2.1–10.2.4), against the
// Notes fixture's generated references: both ways in infer their values
// and result from what they bind; a record is edited through its
// mutation's arguments, its revision among them; queries, internal and
// streaming references never bind.
// This file is type-checked by `vp check` and never run: every
// `@ts-expect-error` below must stay an error.
import { expectTypeOf } from "vite-plus/test";

import { v } from "../src/index.ts";
import type { Id } from "../src/index.ts";
import { useForm } from "../src/react.ts";
import type { GraspForm, TextFieldName } from "../src/react.ts";
import { api } from "./notes/server/_generated/api.ts";
import { internal } from "./notes/server/_generated/internal.ts";

/** A note as `notes.get` answers it. */
interface Note {
  _createdAt: number;
  _id: Id<"notes">;
  _ownerId: string;
  _updatedAt: number;
  body: string;
  summary: string | null;
  title: string;
}

declare const note: Note;

const searchSchema = v.object({ search: v.string().trim().min(1) });

// The forms, made as a component makes them.
export const useChecks = (): void => {
  // An function-bound form: the input its fields, the result its submit's.
  const create = useForm(api.notes.create, {
    defaultValues: { title: "", body: "" },
    resetOnSuccess: true,
    onSuccess: (id) => {
      expectTypeOf(id).toEqualTypeOf<Id<"notes">>();
    },
  });
  expectTypeOf(create).toEqualTypeOf<
    GraspForm<{ body?: string; title: string }, Id<"notes">>
  >();
  expectTypeOf(create.submit()).toEqualTypeOf<Promise<Id<"notes">>>();
  expectTypeOf<TextFieldName<{ body?: string; title: string }>>().toEqualTypeOf<
    "body" | "title"
  >();
  // @ts-expect-error -- a form has no record to reload
  void create.reload;
  // @ts-expect-error -- a value of the wrong type
  void useForm(api.notes.create, { defaultValues: { title: 1 } });
  // @ts-expect-error -- an function-bound form takes no onSubmit of its own
  void useForm(api.notes.create, {
    defaultValues: { title: "" },
    onSubmit: () => {},
  });
  // @ts-expect-error -- a query isn't a submission target
  void useForm(api.notes.get, { defaultValues: { id: note._id } });
  // @ts-expect-error -- an internal reference doesn't bind
  void useForm(internal.notes.count, { defaultValues: {} });
  // @ts-expect-error -- a streaming action doesn't bind
  void useForm(api.notes.exportAll, { defaultValues: { format: "csv" } });

  // Editing a record: its values as the defaults, the committed document
  // the result.
  const edit = useForm(api.notes.update, {
    defaultValues: {
      id: note._id,
      title: note.title,
      body: note.body,
    },
  });
  expectTypeOf(edit.submit()).toEqualTypeOf<Promise<Note>>();
  // @ts-expect-error -- the record's ID is missing
  void useForm(api.notes.update, {
    defaultValues: { title: note.title, body: note.body },
  });

  // A local form: the schema's input its fields, the callback's result
  // its submit's, the schema's normalized output the callback's input.
  const search = useForm(searchSchema, {
    defaultValues: { search: "" },
    onSubmit: (values) => {
      expectTypeOf(values).toEqualTypeOf<{ search: string }>();
      return values.search.length;
    },
  });
  expectTypeOf(search.submit()).toEqualTypeOf<Promise<number>>();
  void useForm(searchSchema, {
    // @ts-expect-error -- the schema's input, not anything
    defaultValues: { query: "" },
    onSubmit: () => {},
  });
  // @ts-expect-error -- a local form's values are named fields, not a list
  void useForm(v.array(v.string()), {
    defaultValues: ["first"],
    onSubmit: () => {},
  });
};
