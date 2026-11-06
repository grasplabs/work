// @vitest-environment happy-dom
import type {
  DataModel,
  DataModelChange,
  DataModelField,
  DefinitionPlan,
} from "@grasp-os/shared/data-model";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { AppDataModel } from "./app-data-model.tsx";
import type { ModelChange, ModelOperation } from "./data-model-changes.tsx";

// An App's data model in its workspace's Data view (app-data-model.tsx),
// against core's `chats.dataModel` and `chats.defineDraft` as the page
// reaches them: what a person does becomes the definition's own
// operations, each previewed first, and what publishing does to the
// records the App holds is said before a change that needs a value,
// retypes or removes. Core applies the operations and plans them (core's
// draft-data-model.test.ts); here it answers as a test scripts it.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const nothingPlanned: DefinitionPlan = {
  accepted: true,
  addedTables: [],
  addedFields: [],
  widenedFields: [],
  checks: [],
  keptTables: [],
  keptFields: [],
  accessChanges: [],
  sensitiveTables: [],
  refused: [],
};

const text = (name: string, required = false): DataModelField => ({
  id: `id-${name}`,
  name,
  type: { kind: "text", trim: false, min: null, max: null },
  required,
  code: "v.string()",
});

/** The notes table: a required title, and an optional status. */
const notesTable = (): DataModel["tables"][number] => ({
  id: "notes",
  name: "notes",
  fields: [text("title", true), text("status")],
  indexes: [],
  searchIndex: null,
  sensitive: false,
  access: {
    read: "appMembers",
    write: "appMembers",
    rows: { read: [], write: [] },
  },
});

/** A model of the notes table alone. */
const notesModel = (): DataModel => ({
  tables: [notesTable()],
  preferences: [],
  permissions: [],
});

/** Core's answer for an operation: the model and plan after it, or a problem. */
type Answer = (
  operation: ModelOperation,
  model: DataModel
) =>
  | { ok: false; problem: string }
  | { ok: true; model: DataModel; plan: DefinitionPlan };

/** Every change sent to core (an operation, or a few as one), and whether it was a preview. */
interface Sent {
  operation: ModelChange;
  preview: boolean;
}

/** A change's operations, in order. */
const operationsIn = (change: ModelChange): readonly ModelOperation[] =>
  "op" in change ? [change] : change;

const settled = async (): Promise<void> => {
  for (let turn = 0; turn < 3; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one turn after another
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<boolean>();
      setTimeout(() => {
        resolve(true);
      }, 0);
      await promise;
    });
  }
};

/**
 * The Data view on a draft whose model is `model`, core answering each
 * operation with `answer`; with `running`, the chat's agent at work.
 */
const shown = async (
  model: DataModel,
  answer: Answer,
  { running = false }: { running?: boolean } = {}
) => {
  const sent: Sent[] = [];
  let held = model;
  const chats = {
    dataModel: async () => {
      await Promise.resolve();
      return { model: held, plan: nothingPlanned };
    },
    defineDraft: async (
      _chatId: string,
      _app: string,
      operation: ModelChange,
      preview = false
    ): Promise<DataModelChange> => {
      await Promise.resolve();
      sent.push({ operation, preview });
      // A few operations as one: each after the one before, all or none.
      let after: DataModel = held;
      let plan = nothingPlanned;
      for (const each of operationsIn(operation)) {
        const answered = answer(each, after);
        if (!answered.ok) {
          return answered;
        }
        ({ model: after, plan } = answered);
      }
      if (!preview) {
        held = after;
      }
      return { ok: true, model: after, plan, change: plan };
    },
  };
  // The live App: no version yet, so no records to read.
  const apps = {
    data: {
      tables: async () => {
        await Promise.resolve();
        return { version: null, tables: [] };
      },
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: {
        chats: typeof chats;
        apps: typeof apps;
      }) => Promise<T>
    ): Promise<T> => await action({ chats, apps }),
  };
  const rootRoute = createRootRoute({
    component: () => (
      <AppDataModel
        app="app-1"
        chatId="chat-1"
        revision={1}
        running={running}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: { core },
  });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nProvider>
    );
    await router.load();
  });
  await settled();
  return sent;
};

const press = async (element: Element | null | undefined): Promise<void> => {
  if (!(element instanceof HTMLElement)) {
    throw new TypeError("Nothing to press");
  }
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

/** The last button that reads `name`, or is named so. */
const button = (name: string) =>
  [...document.querySelectorAll("button")].findLast(
    (each) =>
      each.textContent.trim() === name ||
      each.getAttribute("aria-label") === name
  );

/** The last control named `label`. */
const labelled = (label: string) =>
  [...document.querySelectorAll(`[aria-label="${label}"]`)].at(-1);

/** The control the label `label` is for. */
const labelledBy = (label: string) => {
  const named = [...document.querySelectorAll("label")].findLast(
    (each) => each.textContent.trim() === label
  );
  return named?.htmlFor === undefined || named.htmlFor === ""
    ? undefined
    : document.querySelector(`[id="${named.htmlFor}"]`);
};

/** Types `value` into the input named `label`. */
const type = async (label: string, value: string): Promise<void> => {
  const box = labelled(label) ?? labelledBy(label);
  if (!(box instanceof HTMLInputElement)) {
    throw new TypeError(`No input ${label}`);
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

/** Picks `option` from the select named `label`. */
const choose = async (label: string, option: string): Promise<void> => {
  await press(labelled(label));
  await press(
    [...document.querySelectorAll('[role="option"]')].find((each) =>
      each.textContent.trim().startsWith(option)
    )
  );
};

/** The fields the table's Fields view lists, each its button, by name. */
const fieldButtons = (): [string, HTMLElement][] =>
  [
    ...document.querySelectorAll<HTMLElement>(
      '[data-slot="model-field-button"]'
    ),
  ].map((each) => [
    (each.querySelector("span > span")?.textContent ?? "").trim(),
    each,
  ]);

/** The fields the table's Fields view lists, by name. */
const fieldsShown = (): string[] => fieldButtons().map(([name]) => name);

/** Opens the field `name` from the Fields view's list. */
const openField = async (name: string): Promise<void> => {
  await press(fieldButtons().find(([listed]) => listed === name)?.[1]);
};

/** Adds the option `value` to the choice open. */
const addOption = async (value: string): Promise<void> => {
  await type("New option", value);
  await press(button("Add option"));
};

/** Opens the table's Fields view, from its bar. */
const showFields = async (): Promise<void> => {
  await press(button("Fields"));
};

/** Adds a field in the Fields view: its name, kind, and what more it takes. */
const addField = async (
  name: string,
  kind: string,
  more?: () => Promise<void>
): Promise<void> => {
  // Starts a new field from its kind, picked from all of them laid out.
  await press(button("Add field"));
  await press(
    [
      ...document.querySelectorAll('[data-slot="field-type-gallery"] button'),
    ].find((each) => each.textContent.startsWith(kind))
  );
  await type("Field name", name);
  await more?.();
  await press(button("Add field"));
};

/** `model` with `field` added to its first table. */
const withField = (model: DataModel, field: DataModelField): DataModel => ({
  ...model,
  tables: model.tables.map((table, index) =>
    index === 0 ? { ...table, fields: [...table.fields, field] } : table
  ),
});

describe("an App's data model, changed in its workspace", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("creates a table, and adds a field of each kind in line, each sent as the definition's own operation", async () => {
    const empty: DataModel = { tables: [], preferences: [], permissions: [] };
    const sent = await shown(empty, (operation, model) => {
      if (operation.op === "addTable") {
        return {
          ok: true,
          model: {
            ...model,
            tables: [
              {
                ...notesTable(),
                id: "t",
                name: operation.name,
                fields: [],
              },
            ],
          },
          plan: { ...nothingPlanned, addedTables: [operation.name] },
        };
      }
      if (operation.op === "addField") {
        return {
          ok: true,
          model: withField(model, text(operation.name)),
          plan: nothingPlanned,
        };
      }
      throw new Error(`Not asked for: ${operation.op}`);
    });
    const emptyShown = document.body.textContent.includes("No tables yet");

    await press(button("New table"));
    await type("Table name", "Open tasks");
    const savedAs = document.body.textContent.includes("Saved as openTasks");
    await choose("Who can see and change its records", "Only the person");
    await press(button("Create table"));
    const title = document.querySelector(
      'nav [aria-current="true"]'
    )?.textContent;

    const kinds: [string, string, (() => Promise<void>)?][] = [
      ["title", "Text"],
      ["estimate", "Number"],
      ["done", "Yes or no"],
      ["due", "Date"],
      [
        "status",
        "Choice",
        async () => {
          await addOption("open");
          await addOption("done");
          await addOption("open");
        },
      ],
      [
        "parent",
        "Link to a table",
        async () => {
          await choose("Links to", "openTasks");
        },
      ],
      ["owner", "Person"],
      ["contact", "Email"],
      ["attachment", "File"],
      [
        "budget",
        "Money",
        async () => {
          await press(labelledBy("Required"));
        },
      ],
    ];
    await showFields();
    for (const [name, kind, more] of kinds) {
      // oxlint-disable-next-line no-await-in-loop -- one field after another, as a person adds them
      await addField(name, kind, more);
    }

    expect({
      emptyShown,
      savedAs,
      title,
      made: sent
        .filter(({ preview }) => !preview)
        .map(({ operation }) => operation),
      previewedFirst: sent.filter(({ preview }) => preview).length,
      fields: fieldsShown(),
    }).toStrictEqual({
      emptyShown: true,
      savedAs: true,
      title: "openTasks",
      made: [
        {
          op: "addTable",
          name: "openTasks",
          access: { read: "owner", write: "owner" },
        },
        {
          op: "addField",
          table: "openTasks",
          name: "title",
          type: "v.string().optional()",
        },
        {
          op: "addField",
          table: "openTasks",
          name: "estimate",
          type: "v.number().optional()",
        },
        {
          op: "addField",
          table: "openTasks",
          name: "done",
          type: "v.boolean().optional()",
        },
        {
          op: "addField",
          table: "openTasks",
          name: "due",
          type: "v.timestamp().optional()",
        },
        {
          op: "addField",
          table: "openTasks",
          name: "status",
          type: 'v.enum(["open", "done"]).optional()',
        },
        {
          op: "addField",
          table: "openTasks",
          name: "parent",
          type: 'v.id("openTasks").optional()',
        },
        {
          op: "addField",
          table: "openTasks",
          name: "owner",
          type: "v.person().optional()",
        },
        {
          op: "addField",
          table: "openTasks",
          name: "contact",
          type: "v.string().email().optional()",
        },
        {
          op: "addField",
          table: "openTasks",
          name: "attachment",
          type: "v.file().optional()",
        },
        {
          op: "addField",
          table: "openTasks",
          name: "budget",
          type: "v.money()",
        },
      ],
      previewedFirst: 11,
      fields: [
        "title",
        "estimate",
        "done",
        "due",
        "status",
        "parent",
        "owner",
        "contact",
        "attachment",
        "budget",
      ],
    });
  });

  it("renames a field, and retypes one only once the plan is shown and its records' value given", async () => {
    const sent = await shown(notesModel(), (operation, model) => {
      if (operation.op === "renameField") {
        return {
          ok: true,
          model: {
            ...model,
            tables: model.tables.map((table) => ({
              ...table,
              fields: table.fields.map((field) =>
                field.name === operation.field
                  ? { ...field, name: operation.name }
                  : field
              ),
            })),
          },
          plan: nothingPlanned,
        };
      }
      if (operation.op === "changeField") {
        const status: DataModelField = {
          id: "id-status",
          name: "status",
          type: { kind: "choice", values: ["open", "done"] },
          required: true,
          code: 'v.enum(["open", "done"])',
        };
        return {
          ok: true,
          model: {
            ...model,
            tables: model.tables.map((table) => ({
              ...table,
              fields: table.fields.map((field) =>
                field.name === "status" ? status : field
              ),
            })),
          },
          plan: {
            ...nothingPlanned,
            checks: [
              {
                table: "notes",
                field: "status",
                answer:
                  "answer" in operation ? (operation.answer ?? null) : null,
              },
            ],
          },
        };
      }
      throw new Error(`Not asked for: ${operation.op}`);
    });

    // Each opened from the list, beside it.
    await showFields();
    await openField("title");
    await type("Field name", "heading");
    await press(button("Save"));
    const renamed = fieldsShown();

    await openField("status");
    await choose("Type", "Choice");
    await addOption("open");
    await addOption("done");
    await press(labelledBy("Required"));
    await press(button("Save"));
    const asked = document.body.textContent.includes(
      "notes already holds records. What should the ones without status get?"
    );
    const blocked = button("Make the change")?.hasAttribute("disabled");
    await choose("Value for status", "open");
    await press(button("Make the change"));
    await press(button("1 change to publish"));
    const planned = document.body.textContent.includes(
      "Records in notes that lack status get “open”."
    );

    expect({
      renamed,
      asked,
      blocked,
      planned,
      made: sent
        .filter(({ preview }) => !preview)
        .map(({ operation }) => operation),
    }).toStrictEqual({
      renamed: ["heading", "status"],
      asked: true,
      blocked: true,
      planned: true,
      made: [
        { op: "renameField", table: "notes", field: "title", name: "heading" },
        {
          op: "changeField",
          table: "notes",
          field: "status",
          type: 'v.enum(["open", "done"])',
          answer: "open",
        },
      ],
    });
  });

  it("removes a field once it says the values are kept, and says core's problem for a change it can't take", async () => {
    const sent = await shown(notesModel(), (operation, model) => {
      if (operation.op === "removeField") {
        return {
          ok: true,
          model: {
            ...model,
            tables: model.tables.map((table) => ({
              ...table,
              fields: table.fields.filter(
                ({ name }) => name !== operation.field
              ),
            })),
          },
          plan: {
            ...nothingPlanned,
            keptFields: [{ table: "notes", field: operation.field }],
          },
        };
      }
      return {
        ok: false,
        problem:
          "`notes` has a field `title` already: change it with changeField.",
      };
    });

    await showFields();
    await openField("status");
    await press(button("Remove"));
    const said = document.body.textContent.includes(
      "Keeps the values of status in notes, though nothing reads them any more."
    );
    await press(button("Remove"));
    const removed = fieldsShown();
    await addField("title", "Text");

    expect({
      said,
      removed,
      problem: document.querySelector('[role="alert"]')?.textContent,
      made: sent
        .filter(({ preview }) => !preview)
        .flatMap(({ operation }) => operationsIn(operation))
        .map(({ op }) => op),
    }).toStrictEqual({
      said: true,
      removed: ["title"],
      problem:
        "`notes` has a field `title` already: change it with changeField.",
      made: ["removeField"],
    });
  });

  it("says what each kind takes in its own editor, and sends it as code declares it", async () => {
    const sent = await shown(notesModel(), (operation, model) => {
      if (operation.op === "addField") {
        return {
          ok: true,
          model: withField(model, text(operation.name)),
          plan: nothingPlanned,
        };
      }
      throw new Error(`Not asked for: ${operation.op}`);
    });

    await showFields();
    await addField("estimate", "Number", async () => {
      await press(labelledBy("Allow decimals"));
      await type("Lowest", "0");
      await type("Highest", "100");
    });
    await addField("done", "Yes or no", async () => {
      await press(labelledBy("No"));
    });
    await addField("parent", "Link to a table", async () => {
      await press(labelledBy("Delete this record too"));
    });
    await addField("title2", "Text", async () => {
      await press(labelledBy("Remove spaces at the start and end"));
      await type("Most characters", "200");
    });
    await addField("crossed", "Number", async () => {
      await type("Lowest", "5");
      await type("Highest", "1");
    });
    const crossedRefused = button("Add field")?.hasAttribute("disabled");

    expect({
      made: sent
        .filter(({ preview }) => !preview)
        .flatMap(({ operation }) => operationsIn(operation))
        .map((operation) =>
          operation.op === "addField" ? operation.type : operation.op
        ),
      crossedRefused,
    }).toStrictEqual({
      made: [
        "v.number().integer().min(0).max(100).optional()",
        "v.boolean().default(false)",
        'v.id("notes", { onDelete: "cascade" }).optional()',
        "v.string().trim().max(200).optional()",
      ],
      crossedRefused: true,
    });
  });

  it("makes a rename and a retype as one change, and keeps a form as typed when its review is cancelled", async () => {
    const sent = await shown(notesModel(), (operation, model) => {
      if (operation.op === "renameField") {
        return {
          ok: true,
          model: {
            ...model,
            tables: model.tables.map((table) => ({
              ...table,
              fields: table.fields.map((field) =>
                field.name === operation.field
                  ? { ...field, name: operation.name }
                  : field
              ),
            })),
          },
          plan: nothingPlanned,
        };
      }
      if (operation.op === "changeField") {
        return { ok: true, model, plan: nothingPlanned };
      }
      if (operation.op === "addField") {
        // notes holds records: a required field asks what they get.
        return {
          ok: true,
          model: withField(model, text(operation.name, true)),
          plan: {
            ...nothingPlanned,
            checks: [{ table: "notes", field: operation.name, answer: null }],
          },
        };
      }
      throw new Error(`Not asked for: ${operation.op}`);
    });

    await showFields();
    await openField("status");
    await type("Field name", "state");
    await press(labelledBy("Required"));
    await press(button("Save"));
    await press(button("Make the change"));
    const renamed = fieldsShown();

    await addField("priority", "Text", async () => {
      await press(labelledBy("Required"));
    });
    const asked = document.body.textContent.includes(
      "What should the ones without priority get?"
    );
    await press(button("Cancel"));
    const kept = labelled("Field name");

    expect({
      made: sent
        .filter(({ preview }) => !preview)
        .map(({ operation }) => operation),
      renamed,
      asked,
      kept: kept instanceof HTMLInputElement ? kept.value : undefined,
    }).toStrictEqual({
      made: [
        [
          { op: "renameField", table: "notes", field: "status", name: "state" },
          {
            op: "changeField",
            table: "notes",
            field: "state",
            type: "v.string()",
          },
        ],
      ],
      renamed: ["title", "state"],
      asked: true,
      kept: "priority",
    });
  });

  it("changes nothing while the chat's agent works on the App", async () => {
    await shown(
      notesModel(),
      () => {
        throw new Error("Nothing is sent");
      },
      { running: true }
    );

    await showFields();

    expect({
      newTable: button("New table")?.hasAttribute("disabled"),
      addField: button("Add field")?.hasAttribute("disabled"),
      rename: labelled("Field name")?.hasAttribute("disabled"),
      move: labelled("Move title")?.hasAttribute("disabled"),
    }).toStrictEqual({
      newTable: true,
      addField: true,
      rename: true,
      move: true,
    });
  });
});
