import { screenLimits } from "@grasp-os/shared/screen-limits";
import { FormApi } from "@tanstack/react-form";
import { describe, expect, it, vi } from "vite-plus/test";

import { clientInternals, GraspClient } from "../src/client-core.ts";
import { GraspError } from "../src/client-error.ts";
import { DraftStore, writeDraft } from "../src/form-drafts.ts";
import type { DraftPersistence } from "../src/form-drafts.ts";
import { bindForm, FormBinding } from "../src/form.ts";
import type { DraftSlot, FormApiOf } from "../src/form.ts";
import type { ArgsOf } from "../src/references.ts";
import { draftLookupMs, pageDrafts } from "../src/screen-runtime.ts";
import { isPlainObject } from "../src/value-descriptor.ts";
import type { ValueDescriptor } from "../src/value-descriptor.ts";
import { descriptorOf } from "../src/value-schema.ts";
import { v } from "../src/values.ts";
import { api } from "./notes/.grasp/references.ts";

// A record form's unsaved draft (GRA-254) against the ways it gets lost:
// the editor unmounting, a stale save refused, a newer record arriving, a
// refresh of the page, a schema that changed, and access that ended. Each
// binding here is one mounted editor; a second binding over the same store
// is the same note opened again, and a store made from what another one
// wrote is the frame after a refresh.

const id = "01890000-0000-7000-8000-000000000001";

/** A note as `notes.get` answers it, at `rev`. */
const note = (rev: number, change: Record<string, unknown> = {}) => ({
  _id: id,
  _rev: rev,
  _creationTime: 1,
  _updatedAt: 1,
  title: "Before",
  body: "Body",
  ...change,
});

/** What a fake page keeps of the drafts it was written, by key. */
const page = (initial: Record<string, string> = {}) => {
  const kept = new Map(Object.entries(initial));
  let cleared = 0;
  const persistence: DraftPersistence = {
    initial,
    write: (key, text) => {
      if (text === null) {
        kept.delete(key);
      } else {
        kept.set(key, text);
      }
    },
    clear: () => {
      cleared += 1;
      kept.clear();
    },
  };
  return { persistence, kept, cleared: () => cleared };
};

const slotOf = (store: DraftStore): DraftSlot => ({
  store,
  key: `record:${JSON.stringify([api.notes.update.resourceId, api.notes.update.contractId, id])}`,
  fingerprint: api.notes.update.fingerprint,
});

/** What the host answers a save of a revision someone else's overtook. */
const conflict = () =>
  new GraspError({
    code: "data.conflict",
    message: "This changed since you opened it.",
    category: "domain",
    retryable: false,
    requestId: "r",
  });

/** What a save sent, and how it answers: the committed note, or `fail`. */
const saves = () => {
  const sent: Record<string, unknown>[] = [];
  let failure: Error | undefined;
  return {
    sent,
    failWith: (error: Error | undefined) => {
      failure = error;
    },
    send: async (input: unknown) => {
      await Promise.resolve();
      const args = isPlainObject(input) ? input : {};
      sent.push(args);
      if (failure !== undefined) {
        throw failure;
      }
      return note(Number(args.expectedRevision) + 1, {
        title: args.title,
        body: args.body,
      });
    },
  };
};

/** An editor of `record` over `store`, mounted on a TanStack form, as `useForm` makes it. */
const editor = (
  record: Record<string, unknown>,
  store: DraftStore,
  send: (input: unknown) => Promise<unknown>,
  args: ValueDescriptor = api.notes.update.args,
  mapper: (baseline: unknown) => unknown = (baseline) =>
    isPlainObject(baseline)
      ? { id: baseline._id, expectedRevision: baseline._rev }
      : {}
) => {
  const binding = new FormBinding(
    {
      kind: "record",
      args,
      fields: ["title", "body"],
      send,
    },
    { title: record.title, body: record.body },
    { record, args: mapper },
    slotOf(store)
  );
  const form = new FormApi({ defaultValues: binding.initialValues });
  form.mount();
  // SAFETY: the binding reads the form's values and reset, which a plain
  // FormApi has; the React parts it never touches here.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- see SAFETY
  binding.attach(form as unknown as FormApiOf<Record<string, unknown>>);
  binding.supply(record);
  // Committed, as the hook's effect marks it.
  binding.setMounted(true);
  /** Types `value` into `field`, as a control does. */
  const type = (field: string, value: string | null) => {
    form.setFieldValue(field, value);
    binding.fieldChanged(field);
  };
  return { binding, form, type };
};

/** Why `promise` rejected, or that it resolved. */
const settle = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    return { resolved: await promise };
  } catch (error) {
    return { rejected: error };
  }
};

describe("a record form's draft", () => {
  it("outlives its editor, and comes back in the next editor of the same note", () => {
    const store = new DraftStore();
    const first = editor(note(3), store, saves().send);
    first.type("title", "Mine");

    // The note opened again: the draft, not the record, is in the fields.
    const again = editor(note(3), store, saves().send);
    expect(again.form.state.values).toStrictEqual({
      title: "Mine",
      body: "Body",
    });
    // Back to what the record holds: nothing is kept any more.
    again.type("title", "Before");
    expect(
      editor(note(3), store, saves().send).form.state.values
    ).toMatchObject({ title: "Before" });
    expect(store.get(slotOf(store).key)).toBeUndefined();
  });

  it("survives a stale save, and is restored with its old revision and conflict", async () => {
    const store = new DraftStore();
    const save = saves();
    save.failWith(conflict());
    const first = editor(note(3), store, save.send);
    first.type("title", "Mine");
    await settle(first.binding.submit());
    expect(first.binding.status().conflict).toBeTruthy();
    expect(first.form.state.values).toMatchObject({ title: "Mine" });

    // Opened again with the newer note someone else saved: still the
    // draft, still refused as stale, and its save still carries rev 3.
    const again = editor(note(4, { title: "Theirs" }), store, save.send);
    expect(again.form.state.values).toMatchObject({ title: "Mine" });
    expect(again.binding.status()).toMatchObject({
      conflict: true,
      newer: true,
    });
    await settle(again.binding.submit());
    expect(save.sent.at(-1)).toMatchObject({
      expectedRevision: 3,
      title: "Mine",
    });
  });

  it("is never replaced by a newer record, and shows what changed beside the person's changes", () => {
    const { binding, form, type } = editor(
      note(3),
      new DraftStore(),
      saves().send
    );
    type("title", "Mine");
    binding.supply(note(4, { body: "Their body" }));

    expect(form.state.values).toStrictEqual({ title: "Mine", body: "Body" });
    expect(binding.status().newer).toBeTruthy();
    expect(binding.changes()).toStrictEqual({
      latestKnown: true,
      fields: [
        {
          field: "title",
          base: "Before",
          draft: "Mine",
          latest: "Before",
          mine: true,
          theirs: false,
        },
        {
          field: "body",
          base: "Body",
          draft: "Body",
          latest: "Their body",
          mine: false,
          theirs: true,
        },
      ],
    });
  });

  it("re-applies the person's changes on the newer record as a draft, saved at its revision", async () => {
    const store = new DraftStore();
    const save = saves();
    const { binding, form, type } = editor(note(3), store, save.send);
    type("title", "Mine");
    binding.supply(note(4, { body: "Their body" }));

    // Re-applied, deliberately: the person's title on the latest note,
    // as a draft. Nothing was saved; the save then carries rev 4.
    binding.reapply();
    expect(form.state.values).toStrictEqual({
      title: "Mine",
      body: "Their body",
    });
    expect(binding.status()).toMatchObject({ newer: false, conflict: false });
    expect(save.sent).toHaveLength(0);
    await binding.submit();
    expect(save.sent[0]).toMatchObject({
      expectedRevision: 4,
      title: "Mine",
      body: "Their body",
    });
    expect(store.get(slotOf(store).key)).toBeUndefined();
  });

  it("re-applies nothing until a newer record has arrived", async () => {
    const save = saves();
    save.failWith(conflict());
    const { binding, form, type } = editor(
      note(3),
      new DraftStore(),
      save.send
    );
    type("title", "Mine");
    await settle(binding.submit());
    expect(binding.changes().latestKnown).toBeFalsy();
    binding.reapply();
    expect(binding.status().conflict).toBeTruthy();
    expect(form.state.values).toMatchObject({ title: "Mine" });
  });

  it("comes back after a refresh, from what the page kept", async () => {
    const before = page();
    const store = new DraftStore(before.persistence);
    editor(note(3), store, saves().send).type("body", "Half written");
    expect(before.kept.size).toBe(1);

    // The frame starts again with what the page kept.
    const after = new DraftStore(
      page(Object.fromEntries(before.kept)).persistence
    );
    const save = saves();
    const restored = editor(note(5, { title: "Theirs" }), after, save.send);
    expect(restored.form.state.values).toStrictEqual({
      title: "Before",
      body: "Half written",
    });
    expect(restored.binding.status().newer).toBeTruthy();
    await settle(restored.binding.submit());
    expect(save.sent[0]).toMatchObject({ expectedRevision: 3 });
  });

  it("is restored only into an editor of the same note", () => {
    const store = new DraftStore();
    editor(note(3), store, saves().send).type("title", "Mine");
    const other = editor(
      note(3, { _id: "01890000-0000-7000-8000-000000000002" }),
      store,
      saves().send
    );
    expect(other.form.state.values).toMatchObject({ title: "Before" });
  });

  it("is never restored under another contract of the save, whose arguments it may not match", async () => {
    const store = new DraftStore();
    store.put(slotOf(store).key, {
      fingerprint: "an older contract",
      id,
      rev: 3,
      rest: { id, expectedRevision: 3, projectId: "moved" },
      base: { title: "Before", body: "Body" },
      values: { title: "Mine", body: "Body" },
      conflict: false,
      at: Date.now(),
    });
    const save = saves();
    const restored = editor(note(4), store, save.send);
    expect(restored.form.state.values).toMatchObject({ title: "Before" });
    restored.type("title", "Mine again");
    await restored.binding.submit();
    expect(save.sent[0]).toStrictEqual({
      id,
      expectedRevision: 4,
      title: "Mine again",
      body: "Body",
    });
  });

  it("never restores a value the save's field doesn't take", () => {
    const store = new DraftStore();
    editor(note(3), store, saves().send).type("title", "Mine");
    const draft = store.get(slotOf(store).key);
    if (draft === undefined) {
      throw new Error("The draft was kept");
    }
    // A draft the page handed back with a title the save can't take.
    store.put(slotOf(store).key, {
      ...draft,
      values: { ...draft.values, title: 7 },
    });
    const restored = editor(note(3), store, saves().send);
    expect(restored.form.state.values).toMatchObject({ title: "Before" });
  });

  it("restores an edit still unfinished for its field's format, as a half-typed schedule", () => {
    const scheduled = descriptorOf(
      v.object({
        id: v.string(),
        expectedRevision: v.number(),
        title: v.string(),
        body: v.schedule(),
      })
    );
    const daily = { cron: "0 9 * * *", timeZone: "Europe/Amsterdam" };
    const halfTyped = { cron: "0 9 *", timeZone: "Europe/Amster" };
    const store = new DraftStore();
    const first = editor(
      note(3, { body: daily }),
      store,
      saves().send,
      scheduled
    );
    first.form.setFieldValue("body", halfTyped);
    first.binding.fieldChanged("body");
    const reopened = editor(
      note(3, { body: daily }),
      store,
      saves().send,
      scheduled
    );
    expect(reopened.form.state.values.body).toStrictEqual(halfTyped);
  });

  it("restores an edit still unfinished for one of its field's forms, as an empty text in text or number", () => {
    const either = descriptorOf(
      v.object({
        id: v.string(),
        expectedRevision: v.number(),
        title: v.string(),
        body: v.union(v.string().min(1), v.number()),
      })
    );
    const store = new DraftStore();
    editor(note(3), store, saves().send, either).type("body", "");
    const reopened = editor(note(3), store, saves().send, either);
    expect(reopened.form.state.values.body).toBe("");
  });

  it("drops what was kept of a draft once the App's mapper fails on a later edit", () => {
    const store = new DraftStore();
    let failing = false;
    const first = editor(
      note(3),
      store,
      saves().send,
      api.notes.update.args,
      (baseline) => {
        if (failing) {
          throw new Error("The mapper's data is gone.");
        }
        return isPlainObject(baseline)
          ? { id: baseline._id, expectedRevision: baseline._rev }
          : {};
      }
    );
    first.type("title", "First edit");
    failing = true;
    first.type("title", "Second edit");
    const reopened = editor(note(3), store, saves().send);
    expect(reopened.form.state.values.title).toBe("Before");
  });

  it("restores an edit unfinished for a form of a value nested in its field", () => {
    const nested = descriptorOf(
      v.object({
        id: v.string(),
        expectedRevision: v.number(),
        title: v.string(),
        body: v.object({ text: v.union(v.string().min(1), v.number()) }),
      })
    );
    const store = new DraftStore();
    const first = editor(
      note(3, { body: { text: "Kept" } }),
      store,
      saves().send,
      nested
    );
    first.form.setFieldValue("body", { text: "" });
    first.binding.fieldChanged("body");
    const reopened = editor(
      note(3, { body: { text: "Kept" } }),
      store,
      saves().send,
      nested
    );
    expect(reopened.form.state.values.body).toStrictEqual({ text: "" });
  });

  it("restores an edit unfinished for a form of a dictionary's value", () => {
    const dictionary = descriptorOf(
      v.object({
        id: v.string(),
        expectedRevision: v.number(),
        title: v.string(),
        body: v.record(v.union(v.string().min(1), v.null())),
      })
    );
    const store = new DraftStore();
    const first = editor(
      note(3, { body: { a: "Kept" } }),
      store,
      saves().send,
      dictionary
    );
    first.form.setFieldValue("body", { a: "" });
    first.binding.fieldChanged("body");
    const reopened = editor(
      note(3, { body: { a: "Kept" } }),
      store,
      saves().send,
      dictionary
    );
    expect(reopened.form.state.values.body).toStrictEqual({ a: "" });
  });

  it("is never restored by a form of other fields, whose kept arguments may lack one", () => {
    const store = new DraftStore();
    editor(note(3), store, saves().send).type("title", "Mine");
    const binding = new FormBinding(
      {
        kind: "record",
        args: api.notes.update.args,
        fields: ["title"],
        send: saves().send,
      },
      { title: "Before" },
      { record: note(3) },
      slotOf(store)
    );
    expect(binding.initialValues).toStrictEqual({ title: "Before" });
  });

  it("restores a required field the person cleared, for the save to check", () => {
    const store = new DraftStore();
    const first = editor(note(3), store, saves().send);
    first.form.setFieldValue("body", undefined);
    first.binding.fieldChanged("body");
    const reopened = editor(note(3), store, saves().send);
    expect(reopened.form.state.values.body).toBeUndefined();
  });

  it("restores an object field with a nested value cleared, and the rest of its edits", () => {
    const nested = descriptorOf(
      v.object({
        id: v.string(),
        expectedRevision: v.number(),
        title: v.string(),
        body: v.object({ name: v.string(), description: v.string() }),
      })
    );
    const record = note(3, { body: { name: "Name", description: "Old" } });
    const store = new DraftStore();
    const first = editor(record, store, saves().send, nested);
    first.form.setFieldValue("body", { name: undefined, description: "New" });
    first.binding.fieldChanged("body");
    const reopened = editor(record, store, saves().send, nested);
    expect(reopened.form.state.values.body).toStrictEqual({
      name: undefined,
      description: "New",
    });
  });

  it("keeps an item of a list cleared from null to no value as an edit", () => {
    const listed = descriptorOf(
      v.object({
        id: v.string(),
        expectedRevision: v.number(),
        title: v.string(),
        body: v.array(v.string().nullable()),
      })
    );
    const store = new DraftStore();
    const first = editor(
      note(3, { body: [null] }),
      store,
      saves().send,
      listed
    );
    first.form.setFieldValue("body", [undefined]);
    first.binding.fieldChanged("body");
    expect(store.get(slotOf(store).key)?.values.body).toStrictEqual([
      undefined,
    ]);
  });

  it("restores a money value with an amount the person cleared", () => {
    const priced = descriptorOf(
      v.object({
        id: v.string(),
        expectedRevision: v.number(),
        title: v.string(),
        body: v.money(),
      })
    );
    const record = note(3, { body: { minorUnits: 100, currency: "EUR" } });
    const store = new DraftStore();
    const first = editor(record, store, saves().send, priced);
    first.form.setFieldValue("body", {
      minorUnits: undefined,
      currency: "USD",
    });
    first.binding.fieldChanged("body");
    const reopened = editor(record, store, saves().send, priced);
    expect(reopened.form.state.values.body).toStrictEqual({
      minorUnits: undefined,
      currency: "USD",
    });
  });

  it("restores a nullable field's edit from or to null, as its schema takes both", () => {
    const nullableTitle = descriptorOf(
      v.object({
        id: v.string(),
        expectedRevision: v.number(),
        title: v.string().nullable(),
        body: v.string(),
      })
    );
    const store = new DraftStore();
    editor(note(3, { title: null }), store, saves().send, nullableTitle).type(
      "title",
      "Mine"
    );
    const typed = editor(
      note(3, { title: null }),
      store,
      saves().send,
      nullableTitle
    );
    const other = new DraftStore();
    editor(note(3), other, saves().send, nullableTitle).type("title", null);
    const cleared = editor(note(3), other, saves().send, nullableTitle);
    expect({
      typed: typed.form.state.values.title,
      cleared: cleared.form.state.values.title,
    }).toStrictEqual({ typed: "Mine", cleared: null });
  });

  it("is cleared, here and in the page, when access ends", async () => {
    const kept = page();
    const client = new GraspClient({
      call: async () =>
        await Promise.resolve({
          result: {
            ok: false,
            error: {
              code: "role.forbidden",
              message: "No.",
              category: "authorization",
              retryable: false,
              requestId: "r",
            },
          },
        }),
      watch: async () => {
        await Promise.resolve();
        throw new Error("Nothing here follows a query.");
      },
      drafts: kept.persistence,
    });
    const { drafts } = clientInternals(client);
    editor(note(3), drafts, saves().send).type("title", "Mine");
    await settle(
      client.query(api.notes.list, { pagination: { pageSize: 10 } })
    );
    expect(drafts.get(slotOf(drafts).key)).toBeUndefined();
    expect(kept.cleared()).toBe(1);
  });

  it("is never written back by a form whose save access ended refused", async () => {
    const kept = page();
    const client = new GraspClient({
      call: async () =>
        await Promise.resolve({
          result: {
            ok: false,
            error: {
              code: "role.forbidden",
              message: "No.",
              category: "authorization",
              retryable: false,
              requestId: "r",
            },
          },
        }),
      watch: async () => {
        await Promise.resolve();
        throw new Error("Nothing here follows a query.");
      },
      drafts: kept.persistence,
    });
    const internals = clientInternals(client);
    const { binding, type } = editor(
      note(3),
      internals.drafts,
      async (input) =>
        await client.mutation(
          api.notes.update,
          // SAFETY: the binding sends the update's arguments, as its
          // contract checked them.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          input as ArgsOf<typeof api.notes.update>
        ),
      api.notes.update.args
    );
    type("title", "Mine");
    await settle(binding.submit());
    expect({
      draft: internals.drafts.get(slotOf(internals.drafts).key),
      page: [...kept.kept.keys()],
    }).toStrictEqual({ draft: undefined, page: [] });
  });
});

describe("a draft of two Apps' saves of the same path and note", () => {
  it("is each App's own, through the one client", () => {
    const client = new GraspClient({
      call: async () =>
        await Promise.resolve({ result: { ok: true, value: null } }),
      watch: async () => {
        await Promise.resolve();
        throw new Error("Nothing here follows a query.");
      },
    });
    const mount = (reference: unknown) => {
      const binding = bindForm(client, reference, {
        record: note(3),
        fields: ["title", "body"],
        args: (baseline: unknown) =>
          isPlainObject(baseline)
            ? { id: baseline._id, expectedRevision: baseline._rev }
            : {},
      });
      const form = new FormApi({ defaultValues: binding.initialValues });
      form.mount();
      // SAFETY: as `editor` attaches one.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- see SAFETY
      binding.attach(form as unknown as FormApiOf<Record<string, unknown>>);
      binding.supply(note(3));
      binding.setMounted(true);
      return { binding, form };
    };
    const ours = mount(api.notes.update);
    ours.form.setFieldValue("title", "Ours");
    ours.binding.fieldChanged("title");
    const theirs = mount({ ...api.notes.update, resourceId: "another-app" });
    expect(theirs.form.state.values.title).toBe("Before");
  });
});

describe("a draft and the editor that owns it", () => {
  it("is never touched by a closed editor's late save, once the note was opened again and edited", async () => {
    const store = new DraftStore();
    const answer = Promise.withResolvers<null>();
    const save = saves();
    const first = editor(note(3), store, async (input) => {
      await answer.promise;
      return await save.send(input);
    });
    first.type("title", "Saving");
    const saving = settle(first.binding.submit());
    // Closed while the save waits; opened again, and edited anew.
    first.binding.setMounted(false);
    const second = editor(note(3), store, saves().send);
    second.type("title", "Newer");

    answer.resolve(null);
    await saving;

    expect(store.get(slotOf(store).key)?.values).toStrictEqual({
      title: "Newer",
      body: "Body",
    });
  });

  it("is gone once a closed editor's save of it commits, and the note opens as saved", async () => {
    const store = new DraftStore();
    const answer = Promise.withResolvers<null>();
    const save = saves();
    const first = editor(note(3), store, async (input) => {
      await answer.promise;
      return await save.send(input);
    });
    first.type("title", "Saving");
    const saving = settle(first.binding.submit());
    first.binding.setMounted(false);
    answer.resolve(null);
    await saving;
    const reopened = editor(note(4, { title: "Saving" }), store, saves().send);
    expect({
      kept: store.get(slotOf(store).key),
      values: reopened.form.state.values,
    }).toStrictEqual({
      kept: undefined,
      values: { title: "Saving", body: "Body" },
    });
  });

  it("keeps a field cleared while editing, though it couldn't be saved yet", () => {
    const store = new DraftStore();
    editor(note(3), store, saves().send).type("title", "");
    const reopened = editor(note(3), store, saves().send);
    expect(reopened.form.state.values).toMatchObject({ title: "" });
  });
});

/** An editor of note 3 rendered over `store`, not yet committed. */
const rendered = (store: DraftStore) => {
  const binding = new FormBinding(
    {
      kind: "record",
      args: api.notes.update.args,
      fields: ["title", "body"],
      send: saves().send,
    },
    { title: "Before", body: "Body" },
    {
      record: note(3),
      args: (baseline: unknown) =>
        isPlainObject(baseline)
          ? { id: baseline._id, expectedRevision: baseline._rev }
          : {},
    },
    { ...slotOf(store), epoch: store.epoch }
  );
  const form = new FormApi({ defaultValues: binding.initialValues });
  return {
    binding,
    form,
    /** Commits it, as the hook's effect does. */
    mount: () => {
      form.mount();
      // SAFETY: as `editor` attaches one.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- see SAFETY
      binding.attach(form as unknown as FormApiOf<Record<string, unknown>>);
      binding.supply(note(3));
      binding.setMounted(true);
    },
  };
};

describe("a draft across a refresh and an abandoned render", () => {
  const optionalBody = descriptorOf(
    v.object({
      id: v.string(),
      expectedRevision: v.number(),
      title: v.string(),
      body: v.string().optional(),
    })
  );

  /** A store made from what `store` wrote to the page: the frame after a refresh. */
  const refreshed = (before: ReturnType<typeof page>) =>
    new DraftStore(page(Object.fromEntries(before.kept)).persistence);

  it("keeps a field filled in that had no value, and one cleared to none, across a refresh", () => {
    const filling = page();
    const fillStore = new DraftStore(filling.persistence);
    const withoutBody = note(3, { body: undefined });
    editor(withoutBody, fillStore, saves().send, optionalBody).type(
      "body",
      "Filled"
    );
    const filled = editor(
      withoutBody,
      refreshed(filling),
      saves().send,
      optionalBody
    );

    const clearing = page();
    const clearStore = new DraftStore(clearing.persistence);
    const cleared = editor(note(3), clearStore, saves().send, optionalBody);
    cleared.form.setFieldValue("body", undefined);
    cleared.binding.fieldChanged("body");
    const reopened = editor(
      note(3),
      refreshed(clearing),
      saves().send,
      optionalBody
    );

    expect({
      filled: filled.form.state.values.body,
      cleared: Object.hasOwn(reopened.form.state.values, "body")
        ? reopened.form.state.values.body
        : "absent",
    }).toStrictEqual({ filled: "Filled", cleared: undefined });
  });

  it("keeps an item left out of a list across a refresh, and a key like the marker for it", () => {
    const kept = page();
    const store = new DraftStore(kept.persistence);
    const value = [undefined, "edited", { "\u0000": 0, "\u0000a": 1 }];
    store.put("d", {
      fingerprint: "f",
      id,
      rev: 1,
      rest: null,
      base: { list: [] },
      values: { list: value },
      conflict: false,
      at: Date.now(),
    });
    const after = new DraftStore(
      page(Object.fromEntries(kept.kept)).persistence
    );
    expect(after.get("d")?.values).toStrictEqual({ list: value });
  });

  it("never restores a value nested in its field of another kind that fails only a format", () => {
    const nested = descriptorOf(
      v.object({
        id: v.string(),
        expectedRevision: v.number(),
        title: v.string(),
        body: v.object({ link: v.id("notes") }),
      })
    );
    const store = new DraftStore();
    const record = note(3, { body: { link: id } });
    const first = editor(record, store, saves().send, nested);
    first.form.setFieldValue("body", { link: 123 });
    first.binding.fieldChanged("body");
    const reopened = editor(record, store, saves().send, nested);
    expect(reopened.form.state.values.body).toStrictEqual({ link: id });
  });

  it("never restores a value of another kind that fails only a format, as a number for an ID", () => {
    const withId = descriptorOf(
      v.object({
        id: v.string(),
        expectedRevision: v.number(),
        title: v.id("notes"),
        body: v.string(),
      })
    );
    const store = new DraftStore();
    const first = editor(note(3), store, saves().send, withId);
    first.form.setFieldValue("title", 42);
    first.binding.fieldChanged("title");
    const reopened = editor(note(3), store, saves().send, withId);
    expect(reopened.form.state.values.title).toBe("Before");
  });

  it("shows a newer draft an editor of the note wrote while another one was rendered, once that one mounts", () => {
    const store = new DraftStore();
    const shown = editor(note(3), store, saves().send);
    shown.type("title", "First");
    // Rendered from the draft as it was, committed only later.
    const later = new FormBinding(
      {
        kind: "record",
        args: api.notes.update.args,
        fields: ["title", "body"],
        send: saves().send,
      },
      { title: "Before", body: "Body" },
      {
        record: note(3),
        args: (baseline: unknown) =>
          isPlainObject(baseline)
            ? { id: baseline._id, expectedRevision: baseline._rev }
            : {},
      },
      slotOf(store)
    );
    shown.type("title", "Newer");
    shown.binding.setMounted(false);
    const form = new FormApi({ defaultValues: later.initialValues });
    form.mount();
    // SAFETY: as `editor` attaches one.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- see SAFETY
    later.attach(form as unknown as FormApiOf<Record<string, unknown>>);
    later.supply(note(3));
    later.setMounted(true);
    expect(form.state.values.title).toBe("Newer");
  });

  it("is never written by an editor rendered before access ended, though it commits after", () => {
    const store = new DraftStore();
    const late = rendered(store);
    store.clear();
    late.mount();
    late.form.setFieldValue("title", "Read before");
    late.binding.fieldChanged("title");
    expect(store.get(slotOf(store).key)).toBeUndefined();
  });

  it("never takes up a draft written after access ended, by an editor rendered before", () => {
    const store = new DraftStore();
    const late = rendered(store);
    store.clear();
    // The person now edits the note.
    editor(note(3), store, saves().send).type("title", "Theirs");
    late.mount();
    expect(late.form.state.values.title).toBe("Before");
  });

  it("shows the note as it is once the draft it was rendered from was saved meanwhile", () => {
    const store = new DraftStore();
    editor(note(3), store, saves().send).type("title", "Mine");
    const late = rendered(store);
    expect(late.binding.initialValues.title).toBe("Mine");
    store.drop(slotOf(store).key);
    late.mount();
    expect(late.form.state.values.title).toBe("Before");
  });

  it("is written by the editor shown, though React began another one and abandoned it", () => {
    const store = new DraftStore();
    const shown = editor(note(3), store, saves().send);
    // Rendered for the same note and never committed (a suspended
    // transition): it never mounts.
    void new FormBinding(
      {
        kind: "record",
        args: api.notes.update.args,
        fields: ["title", "body"],
        send: saves().send,
      },
      { title: "Before", body: "Body" },
      { record: note(3) },
      slotOf(store)
    );
    shown.type("title", "Mine");
    expect(store.get(slotOf(store).key)?.values).toMatchObject({
      title: "Mine",
    });
  });
});

describe("the drafts a frame starts with", () => {
  it("starts without them, soon, when the page can't hand them over in time, and never applies a late answer", async () => {
    vi.useFakeTimers();
    try {
      const late = Promise.withResolvers<Record<string, string>>();
      const bridge = {
        drafts: async () => await late.promise,
        saveDraft: async () => {
          await Promise.resolve();
        },
        clearDrafts: async () => {
          await Promise.resolve();
        },
      };
      const persistence = pageDrafts(bridge);
      await vi.advanceTimersByTimeAsync(draftLookupMs);
      const started = await persistence;
      late.resolve({ k: "late" });
      await vi.advanceTimersByTimeAsync(0);
      expect(started.initial).toStrictEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks the page again after its lookup failed, and writes a change made meanwhile once it answers", async () => {
    vi.useFakeTimers();
    try {
      let failing = true;
      const written: [string, string | null][] = [];
      const bridge = {
        drafts: async () => {
          await Promise.resolve();
          if (failing) {
            throw new Error("The page can't say.");
          }
          return {};
        },
        saveDraft: async (key: string, text: string | null) => {
          written.push([key, text]);
          await Promise.resolve();
        },
        clearDrafts: async () => {
          await Promise.resolve();
        },
      };
      const started = await pageDrafts(bridge);
      started.write("edited", "typed");
      failing = false;
      await vi.advanceTimersByTimeAsync(draftLookupMs);
      expect(written).toStrictEqual([["edited", "typed"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops what the page kept of a record saved before its late answer, and holds a bounded number of changes", async () => {
    vi.useFakeTimers();
    try {
      const late = Promise.withResolvers<Record<string, string>>();
      const written: [string, string | null][] = [];
      const bridge = {
        drafts: async () => await late.promise,
        saveDraft: async (key: string, text: string | null) => {
          written.push([key, text]);
          await Promise.resolve();
        },
        clearDrafts: async () => {
          await Promise.resolve();
        },
      };
      const persistence = pageDrafts(bridge);
      await vi.advanceTimersByTimeAsync(draftLookupMs);
      const started = await persistence;
      started.write("saved", null);
      for (let index = 0; index < 100; index += 1) {
        started.write(`d${index}`, "typed");
      }
      late.resolve({ saved: "kept from before" });
      await vi.advanceTimersByTimeAsync(0);
      expect({
        dropped: written.some(
          ([key, text]) => key === "saved" && text === null
        ),
        bounded: written.length <= 2 * screenLimits.drafts.perApp,
      }).toStrictEqual({ dropped: true, bounded: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts, and asks again, past a page whose lookup throws at once", async () => {
    vi.useFakeTimers();
    try {
      let asked = 0;
      const written: string[] = [];
      const bridge = {
        // oxlint-disable-next-line promise-function-async -- throws at once, as a provider may
        drafts: (): Promise<Record<string, string>> => {
          asked += 1;
          if (asked === 1) {
            throw new Error("The page can't say.");
          }
          return Promise.resolve({});
        },
        saveDraft: async (key: string) => {
          written.push(key);
          await Promise.resolve();
        },
        clearDrafts: async () => {
          await Promise.resolve();
        },
      };
      const started = await pageDrafts(bridge);
      started.write("edited", "typed");
      await vi.advanceTimersByTimeAsync(draftLookupMs);
      expect({ initial: started.initial, written }).toStrictEqual({
        initial: {},
        written: ["edited"],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks again past an ask that never answers", async () => {
    vi.useFakeTimers();
    try {
      let asked = 0;
      const written: string[] = [];
      const bridge = {
        drafts: async (): Promise<Record<string, string>> => {
          asked += 1;
          if (asked === 1) {
            throw new Error("The page can't say.");
          }
          if (asked === 2) {
            // Stalls: core never answers it.
            return await Promise.withResolvers<Record<string, string>>()
              .promise;
          }
          return await Promise.resolve({});
        },
        saveDraft: async (key: string) => {
          written.push(key);
          await Promise.resolve();
        },
        clearDrafts: async () => {
          await Promise.resolve();
        },
      };
      const started = await pageDrafts(bridge);
      started.write("edited", "typed");
      await vi.advanceTimersByTimeAsync(3 * draftLookupMs);
      expect({ asked, written }).toStrictEqual({
        asked: 3,
        written: ["edited"],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes the changes made before the page answered once it does, never before", async () => {
    vi.useFakeTimers();
    try {
      const late = Promise.withResolvers<Record<string, string>>();
      const written: [string, string | null][] = [];
      const bridge = {
        drafts: async () => await late.promise,
        saveDraft: async (key: string, text: string | null) => {
          written.push([key, text]);
          await Promise.resolve();
        },
        clearDrafts: async () => {
          await Promise.resolve();
        },
      };
      const persistence = pageDrafts(bridge);
      await vi.advanceTimersByTimeAsync(draftLookupMs);
      const started = await persistence;
      started.write("edited", "first");
      started.write("edited", "newest");
      started.write("saved", null);
      await vi.advanceTimersByTimeAsync(0);
      const before = [...written];
      late.resolve({ edited: "kept", other: "kept" });
      await vi.advanceTimersByTimeAsync(0);
      started.write("later", "after");
      await vi.advanceTimersByTimeAsync(0);
      // The person's own edits of a record replace what the page kept of
      // it; a draft of a record they didn't touch ("other") stays.
      expect({ before, after: written }).toStrictEqual({
        before: [],
        after: [
          ["edited", "newest"],
          ["saved", null],
          ["later", "after"],
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

/** A draft's key in `app`, as a form names it. */
const appKey = (app: string, index: number): string =>
  `record:${JSON.stringify([app, "notes.update", index])}`;

describe("the drafts the client keeps", () => {
  const draft = (at: number, body = "") => ({
    fingerprint: "f",
    id,
    rev: 1,
    rest: null,
    base: { body: "" },
    values: { body },
    conflict: false,
    at,
  });

  it("lets one App's oldest go past its count, never another App's", () => {
    const store = new DraftStore();
    store.put(appKey("other", 0), draft(Date.now()));
    for (let index = 0; index < screenLimits.drafts.perApp + 1; index += 1) {
      store.put(appKey("busy", index), draft(Date.now() + index));
    }
    expect({
      other: store.get(appKey("other", 0)) !== undefined,
      busyOldest: store.get(appKey("busy", 0)),
    }).toStrictEqual({ other: true, busyOldest: undefined });
  });

  it("keeps the save's other arguments as they were across a refresh, a value left out among them", () => {
    const kept = page();
    const store = new DraftStore(kept.persistence);
    store.put("d", {
      ...draft(Date.now(), "x"),
      rest: { items: [undefined, 1] },
    });
    const after = new DraftStore(
      page(Object.fromEntries(kept.kept)).persistence
    );
    expect(after.get("d")?.rest).toStrictEqual({ items: [undefined, 1] });
  });

  it("drops a kept draft nested past any value unread, and starts", () => {
    const deep = `${"[".repeat(10_000)}${"]".repeat(10_000)}`;
    const text = writeDraft(draft(Date.now(), "x")).replace(
      '"rest":null',
      `"rest":${deep}`
    );
    const store = new DraftStore(page({ deep: text }).persistence);
    expect(store.get("deep")).toBeUndefined();
  });

  it("lets the draft written longest ago go past the count, whatever order the page handed them over in", () => {
    const now = Date.now();
    const initial: Record<string, string> = {};
    // Newest first, as the page hands them over.
    for (let index = 0; index < screenLimits.drafts.perApp; index += 1) {
      initial[`d${index}`] = writeDraft(draft(now - index));
    }
    const store = new DraftStore(page(initial).persistence, now);
    store.put("new", draft(now + 1));
    expect({
      newest: store.get("d0", now) !== undefined,
      oldest: store.get(`d${screenLimits.drafts.perApp - 1}`, now),
    }).toStrictEqual({ newest: true, oldest: undefined });
  });

  it("keeps a draft too large for the page in memory only", () => {
    const kept = page();
    const store = new DraftStore(kept.persistence);
    store.put("small", draft(Date.now(), "x"));
    store.put(
      "small",
      draft(Date.now(), "x".repeat(screenLimits.drafts.characters))
    );
    expect(kept.kept.has("small")).toBeFalsy();
    expect(store.get("small")).toBeDefined();
  });

  it("lets the oldest go past the count, and drops a day-old draft unread", () => {
    const store = new DraftStore();
    const start = Date.now();
    for (let index = 0; index <= screenLimits.drafts.perApp; index += 1) {
      store.put(`d${index}`, draft(start + index));
    }
    expect(store.get("d0")).toBeUndefined();
    expect(store.get(`d${screenLimits.drafts.perApp}`)).toBeDefined();

    const now = Date.now();
    const old = new DraftStore(
      page({
        old: writeDraft(draft(now - screenLimits.drafts.maxAgeMs - 1)),
        young: writeDraft(draft(now)),
        broken: "{",
      }).persistence,
      now
    );
    expect(old.get("old")).toBeUndefined();
    expect(old.get("broken")).toBeUndefined();
    expect(old.get("young")).toBeDefined();
  });

  it("is kept by the page as soon as it is typed, so a refresh right after finds it", () => {
    const kept = page();
    const store = new DraftStore(kept.persistence);
    editor(note(3), store, saves().send).type("body", "Just typed");
    expect(kept.kept.size).toBe(1);
  });

  it("never hands back a draft that grew a day old while the frame stayed open", () => {
    const store = new DraftStore();
    const now = Date.now();
    store.put("open", draft(now, "x"));
    expect({
      soon: store.get("open", now + 1)?.values,
      later: store.get("open", now + screenLimits.drafts.maxAgeMs + 1),
    }).toStrictEqual({ soon: { body: "x" }, later: undefined });
  });

  it("drops what the page kept of a draft it can no longer write as text", () => {
    const kept = page();
    const store = new DraftStore(kept.persistence);
    store.put("d", draft(Date.now(), "x"));
    store.put("d", { ...draft(Date.now(), "y"), rest: { big: 1n } });
    expect({
      page: kept.kept.has("d"),
      memory: store.get("d")?.values,
    }).toStrictEqual({
      page: false,
      memory: { body: "y" },
    });
  });

  it("keeps a draft whose text grows past the limit once escaped in memory only", () => {
    const kept = page();
    const store = new DraftStore(kept.persistence);
    const quotes = '"'.repeat(Math.ceil(screenLimits.drafts.characters / 3));
    store.put("escaped", draft(Date.now(), quotes));
    expect({
      page: kept.kept.has("escaped"),
      memory: store.get("escaped") !== undefined,
    }).toStrictEqual({ page: false, memory: true });
  });

  it("goes on past a page that fails to keep a draft, and clears though the page fails", () => {
    const kept = new Map<string, string>();
    const store = new DraftStore({
      initial: {},
      write: (key, text) => {
        if (key === "broken") {
          throw new Error("The page is gone.");
        }
        if (text !== null) {
          kept.set(key, text);
        }
      },
      clear: () => {
        throw new Error("The page is gone.");
      },
    });
    store.put("broken", draft(Date.now(), "x"));
    store.put("fine", draft(Date.now(), "y"));
    expect(kept.has("fine")).toBeTruthy();
    store.clear();
    expect(store.get("fine")).toBeUndefined();
  });
});
