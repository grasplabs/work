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

// A domain's data page (app-data.tsx), against core's `apps.data` as the
// page reaches it: what one domain's page read never shows for another
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

/** A table of `fields`, read and written by the domain's members. */
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
});

/** The one record core holds of `table` in domain `app`. */
const recordOf = (app: string, table: string): AppDataRecord => ({
  id: `${app}-${table}-1`,
  owner: "builder",
  revision: 1,
  createdAt: "2026-11-03T10:00:00.000Z",
  updatedAt: "2026-11-03T10:00:00.000Z",
  fields: { title: `${app}'s ${table}` },
});

/** Each domain's tables: the second's first declares no fields at all. */
const tables: Record<string, AppDataTable[]> = {
  first: [tableOf("notes", ["title"])],
  second: [tableOf("bare", []), tableOf("notes", ["title"])],
};

/** The page, opened on domain `first`, with a button opening `second`. */
const shown = async () => {
  const apps = {
    data: {
      records: async (app: string, table: string) => {
        await Promise.resolve();
        return { records: [recordOf(app, table)], cursor: null };
      },
      history: async () => {
        await Promise.resolve();
        return { changes: [], next: null };
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
        <AppData app={app} tables={tables[app] ?? []} />
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

/** Presses the button whose text is `name`. */
const press = async (name: string) => {
  const button = [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === name
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

describe("a domain's data page", () => {
  afterEach(takenDown);

  it("shows another domain opened on it from that domain's own first table and records", async () => {
    await shown();
    await settled();
    expect(document.body.textContent).toContain("first's notes");

    await press("Open second");
    expect(document.body.textContent).toContain("second-bare-1");
    expect(document.body.textContent).not.toContain("first-notes-1");
  });

  it("opens a record by its ID, in a table that declares no fields", async () => {
    await shown();
    await press("Open second");
    await press("second-bare-1");
    expect(document.body.textContent).toContain("Record second-bare-1");
  });
});
