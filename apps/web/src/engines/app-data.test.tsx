// @vitest-environment happy-dom
import type { AppDataRecord, AppDataTable } from "@grasp-os/shared/app-data";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { AppData } from "./app-data.tsx";

// An App's data page (app-data.tsx), against core's `apps.data` as the
// page reaches it: what one App's page read never shows for another
// opened on it, and every record opens, whatever fields its table has.
// Core decides who may read what (core's app-data.test.ts).

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** Takes the page down. */
const takenDown = (): void => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.replaceChildren();
};

/** A table of `fields`, read and written by the App's members. */
const tableOf = (name: string, fields: string[]): AppDataTable => ({
  name,
  read: "appMembers",
  write: "appMembers",
  sensitive: false,
  fields: fields.map((field) => ({
    name: field,
    kind: "string",
    required: true,
  })),
  records: 1,
});

/** The one record core holds of `table` in App `app`. */
const recordOf = (app: string, table: string): AppDataRecord => ({
  id: `${app}-${table}-1`,
  owner: "builder",
  revision: 1,
  createdAt: "2026-11-03T10:00:00.000Z",
  updatedAt: "2026-11-03T10:00:00.000Z",
  fields: { title: `${app}'s ${table}` },
});

/** Each App's tables: the second's first declares no fields at all. */
const tables: Record<string, AppDataTable[]> = {
  first: [tableOf("notes", ["title"])],
  second: [tableOf("bare", []), tableOf("notes", ["title"])],
};

/** The page, opened on App `first`, with a button opening `second`. */
const shown = async () => {
  const apps = {
    data: {
      // The first App's notes come in two pages; every other table in one.
      records: async (
        app: string,
        table: string,
        _version: number,
        cursor: string | null
      ) => {
        await Promise.resolve();
        if (app === "first" && table === "notes" && cursor === null) {
          return { records: [recordOf(app, table)], cursor: "page-2" };
        }
        if (cursor === "page-2") {
          return {
            records: [
              {
                ...recordOf(app, table),
                id: `${app}-${table}-2`,
                fields: { title: `${app}'s second ${table}` },
              },
            ],
            cursor: null,
          };
        }
        return { records: [recordOf(app, table)], cursor: null };
      },
      history: async () => {
        await Promise.resolve();
        return { changes: [], next: null };
      },
      // A file whose text says "refused" doesn't read, as core refuses one.
      previewImport: async (_app: string, _table: string, csv: string) => {
        await Promise.resolve();
        if (csv.includes("refused")) {
          throw new Error("That isn't a valid request for this App's data.");
        }
        return { columns: ["title"], rows: 1, mapping: { title: "title" } };
      },
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { apps: typeof apps }) => Promise<T>
    ): Promise<T> => await action({ apps }),
  };
  const Page = () => {
    const [app, setApp] = useState("first");
    return (
      <>
        <button
          onClick={() => {
            setApp("second");
          }}
          type="button"
        >
          Open second
        </button>
        <AppData app={app} tables={tables[app] ?? []} version={1} />
      </>
    );
  };
  const router = createRouter({
    routeTree: createRootRoute({ component: Page }),
    history: createMemoryHistory(),
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
};

/** Lets core's answers land. */
const settled = async () => {
  await act(async () => {
    for (let tick = 0; tick < 10; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- a microtask at a time
      await Promise.resolve();
    }
  });
};

/** Picks the open menu's item whose text is `name`. */
const pick = async (name: string) => {
  const item = [...document.querySelectorAll('[role="menuitem"]')].find(
    (each) => each.textContent?.trim() === name
  );
  if (!(item instanceof HTMLElement)) {
    throw new Error(`No menu item ${name}`);
  }
  await act(async () => {
    item.click();
    await Promise.resolve();
  });
  await settled();
};

/** Presses the button whose text, or name, is `name`. */
const press = async (name: string) => {
  const button = [...document.querySelectorAll("button")].find(
    (each) =>
      each.textContent?.trim() === name ||
      each.getAttribute("aria-label") === name ||
      each.getAttribute("title") === name
  );
  if (button === undefined) {
    throw new Error(`No button ${name}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await settled();
};

/** Chooses a CSV file holding `text` in the import dialog, as a person does. */
const choose = async (text: string) => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) {
    throw new Error("No file input");
  }
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File([text], "notes.csv", { type: "text/csv" })],
  });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
  await settled();
};

/** Whether the dialog's Import button may be pressed. */
const importable = (): boolean => {
  const button = [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === "Import"
  );
  return button !== undefined && !button.disabled;
};

describe("an App's data page", () => {
  afterEach(takenDown);

  it("shows another App opened on it from that App's own first table and records", async () => {
    await shown();
    await settled();
    expect(document.body.textContent).toContain("first's notes");

    await press("Open second");
    // Each record by its ID, the whole of it on the button that opens it.
    expect({
      second: document.querySelector('[title="second-bare-1"]') !== null,
      first: document.querySelector('[title="first-notes-1"]') !== null,
    }).toStrictEqual({ second: true, first: false });
  });

  it("loads a table's next page as its last rows come into view, until there is none", async () => {
    await shown();
    await settled();
    await settled();

    expect({
      first: document.body.textContent.includes("first's notes"),
      second: document.body.textContent.includes("first's second notes"),
      rows: document.querySelectorAll('[role="grid"] [role="row"]').length,
    }).toStrictEqual({ first: true, second: true, rows: 3 });
  });

  it("opens a record by its ID, in a table that declares no fields", async () => {
    await shown();
    await press("Open second");
    await press("second-bare-1");
    expect(document.body.textContent).toContain("Record second-bare-1");
  });

  it("forgets a file's preview as soon as another is chosen, Import staying off until that one reads", async () => {
    await shown();
    await settled();
    await press("Import or export");
    await pick("Import from CSV");
    await choose("title\nFirst\n");
    expect(importable()).toBeTruthy();

    await choose("title\nrefused\n");
    expect(importable()).toBeFalsy();
    expect(document.body.textContent).not.toContain("1 row to import.");
  });
});
