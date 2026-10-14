// Compile-time guarantees of `useForm` (spec 10.2.1–10.3.1), against the
// Notes fixture's generated references: the three ways in infer their
// values and result from what they bind; a record form's editable fields
// and `args` partition the arguments, rejecting missing, overlapping or
// mistyped ones; queries, internal and streaming references never bind.
// This file is type-checked by `vp check` and never run: every
// `@ts-expect-error` below must stay an error.
import { expectTypeOf } from "vite-plus/test";

import { v } from "../src/index.ts";
import type { Id } from "../src/index.ts";
import { useForm } from "../src/react.ts";
import type { GraspForm, RecordForm, TextFieldName } from "../src/react.ts";
import { api } from "./notes/.grasp/references.ts";
import { internal } from "./notes/.grasp/server-references.ts";

/** A note as `notes.get` answers it. */
interface Note {
  _createdAt: number;
  _id: Id<"notes">;
  _ownerId: string;
  _rev: number;
  _updatedAt: number;
  body: string;
  summary: string | null;
  title: string;
}

declare const note: Note;

const searchSchema = v.object({ search: v.string().trim().min(1) });

// The forms, made as a component makes them.
export const useChecks = (): void => {
  // An operation-bound form: the input its fields, the result its submit's.
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
  // @ts-expect-error -- an operation-bound form has no reload
  void create.reload;
  // @ts-expect-error -- a value of the wrong type
  void useForm(api.notes.create, { defaultValues: { title: 1 } });
  // @ts-expect-error -- an operation-bound form takes no onSubmit of its own
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

  // A record form: the editable fields from the record, the rest from
  // the captured baseline, the committed document the result.
  const edit = useForm(api.notes.update, {
    record: note,
    fields: ["title", "body"],
    args: (baseline) => ({
      id: baseline._id,
      expectedRevision: baseline._rev,
    }),
  });
  expectTypeOf(edit).toEqualTypeOf<
    RecordForm<{ title: string; body: string }, Note>
  >();
  expectTypeOf(edit.reload).toEqualTypeOf<() => void>();
  // @ts-expect-error -- the mapper can't supply an editable field
  void useForm(api.notes.update, {
    record: note,
    fields: ["title", "body"],
    args: (baseline) => ({
      id: baseline._id,
      expectedRevision: baseline._rev,
      title: baseline.title,
    }),
  });
  // @ts-expect-error -- the revision is missing
  void useForm(api.notes.update, {
    record: note,
    fields: ["title", "body"],
    args: (baseline) => ({ id: baseline._id }),
  });
  // @ts-expect-error -- the id is of another type
  void useForm(api.notes.update, {
    record: note,
    fields: ["title"],
    args: (baseline) => ({
      id: baseline._rev,
      expectedRevision: baseline._rev,
      body: baseline.body,
    }),
  });
  // @ts-expect-error -- `summary` isn't an argument of the mutation
  void useForm(api.notes.update, {
    record: note,
    fields: ["title", "summary"],
    args: (baseline) => ({
      id: baseline._id,
      expectedRevision: baseline._rev,
      body: baseline.body,
    }),
  });
  // @ts-expect-error -- the record's `summary` may be null; the argument may not
  void useForm(api.notes.setSummary, {
    record: note,
    fields: ["summary"],
    args: (baseline) => ({ id: baseline._id, expectedRevision: baseline._rev }),
  });
  // @ts-expect-error -- a record form binds a mutation, not an action
  void useForm(api.notes.tally, {
    record: note,
    fields: [],
    args: () => ({}),
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
};
