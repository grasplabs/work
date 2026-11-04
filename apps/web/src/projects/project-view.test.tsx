// @vitest-environment happy-dom
import type {
  FileItem,
  Project,
  ProjectCursor,
  ProjectItemCandidate,
  ProjectItemsPage,
  ProjectItemRef,
} from "@grasp-os/shared/projects";
import { SidebarProvider } from "@grasp-os/ui/components/sidebar";
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

import { ProjectView } from "./project-view.tsx";

// A project's page against core's projects API as the page reaches it
// over RPC (the boundary from the web app), faked: it keeps what is filed
// in the project and whether it is shared with it. From the ways it can
// fail: filing sharing what nobody chose to share; access going without
// saying whose; someone who only uses the project changing it.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const candidates: ProjectItemCandidate[] = [
  { type: "workflow", id: "wf-quotes", name: "Quotes", builds: true },
];

const project = (role: Project["role"]): Project => ({
  id: "project-1",
  name: "Sell & get paid",
  description: "Quotes to cash",
  icon: "coins",
  role,
  counts: { apps: 0, workflows: 1, connections: 0 },
  owner: { id: "user-olga", name: "Olga" },
  members: [
    {
      type: "person",
      id: "user-ada",
      name: "Ada",
      role: "user",
      addedBy: "user-olga",
      addedAt: "2026-11-01T09:00:00.000Z",
    },
  ],
  moreMembers: false,
  people: 2,
  items: [
    {
      type: "workflow",
      id: "wf-invoices",
      name: "Invoices",
      sharedAs: "user",
      builds: true,
      addedAt: "2026-11-01T10:00:00.000Z",
    },
  ],
  moreItems: false,
  shared: 1,
});

/** Core's projects API, keeping each call it was asked. */
/** Desk, an App filed after Invoices. */
const desk: ProjectItemsPage["items"][number] = {
  type: "app",
  id: "app-desk",
  name: "Desk",
  sharedAs: null,
  builds: true,
  addedAt: "2026-11-02T10:00:00.000Z",
};

/** Invoices again, moved later by a share changed since it was shown. */
const invoicesMoved: ProjectItemsPage["items"][number] = {
  type: "workflow",
  id: "wf-invoices",
  name: "Invoices",
  sharedAs: "builder",
  builds: true,
  addedAt: "2026-11-01T12:00:00.000Z",
};

const fakeProjects = (
  pages: ProjectItemsPage[] = [{ items: [desk], more: false }]
) => {
  const left = [...pages];
  const asked: unknown[][] = [];
  const projects = {
    itemCandidates: async (): Promise<ProjectItemCandidate[]> => {
      await Promise.resolve();
      return candidates;
    },
    file: async (_id: string, file: FileItem): Promise<void> => {
      await Promise.resolve();
      asked.push(["file", file.item.id, file.share]);
    },
    unfile: async (_id: string, item: ProjectItemRef): Promise<void> => {
      await Promise.resolve();
      asked.push(["unfile", item.id]);
    },
    // The pages after Invoices, one each time it is asked.
    items: async (
      _id: string,
      after: ProjectCursor
    ): Promise<ProjectItemsPage> => {
      await Promise.resolve();
      asked.push(["items", after.type, after.id, after.at]);
      return left.shift() ?? { items: [], more: false };
    },
  };
  return { session: { projects }, asked };
};

let root: Root | undefined;

const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/** The page of `shownProject`, on what `session` holds. */
const shown = async (
  session: ReturnType<typeof fakeProjects>["session"],
  shownProject: Project
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      run: (reached: typeof session) => Promise<T>
    ): Promise<T> => await run(session),
  };
  const rootRoute = createRootRoute({
    component: () => (
      <ProjectView identity={{ role: "builder" }} project={shownProject} />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory(),
    context: { core },
  });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <SidebarProvider>
          <RouterProvider router={router} />
        </SidebarProvider>
      </I18nProvider>
    );
    await router.load();
  });
  await settled();
};

const press = async (element: Element | undefined | null) => {
  if (!(element instanceof HTMLElement)) {
    throw new TypeError("Nothing to press");
  }
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (each) =>
      each.textContent?.trim() === name ||
      each.getAttribute("aria-label") === name
  );

const choose = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    // Through the element's own setter, as a person's choice reaches React.
    Reflect.set(HTMLSelectElement.prototype, "value", value, select);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
  await settled();
};

describe("A project's page", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("adds a workflow without sharing it unless asked, and names who would gain access", async () => {
    const { session, asked } = fakeProjects();
    await shown(session, project("builder"));

    await press(button("Add"));
    const select = document.querySelector('[role="dialog"] select');
    if (!(select instanceof HTMLSelectElement)) {
      throw new TypeError("No list of what to add");
    }
    await choose(select, "workflow:wf-quotes");
    const share = document.querySelector('[role="checkbox"]');
    const offer = document.body.textContent ?? "";
    await press(
      [...document.querySelectorAll('[role="dialog"] button')].find(
        (each) => each.textContent?.trim() === "Add"
      )
    );

    expect({
      checked: share?.getAttribute("aria-checked"),
      offer: offer.includes(
        "Also give the 2 people in Sell & get paid access? That is Olga and Ada."
      ),
      asked,
    }).toStrictEqual({
      checked: "false",
      offer: true,
      asked: [["file", "wf-quotes", false]],
    });
  });

  it("names who loses access before taking a shared workflow out", async () => {
    const { session, asked } = fakeProjects();
    await shown(session, project("builder"));

    await press(button("Take Invoices out of the project"));
    const warning =
      document.querySelector('[role="alertdialog"]')?.textContent ?? "";
    await press(button("Take out"));

    expect({
      named: warning.includes("Olga and Ada lose access"),
      asked,
    }).toStrictEqual({ named: true, asked: [["unfile", "wf-invoices"]] });
  });

  it("lets someone who only uses the project change nothing", async () => {
    const { session } = fakeProjects();
    await shown(session, project("user"));

    expect({
      add: button("Add"),
      remove: button("Take Invoices out of the project"),
      change: button("Change"),
      delete: button("Delete"),
      listed: document.body.textContent?.includes("Invoices"),
    }).toStrictEqual({
      add: undefined,
      remove: undefined,
      change: undefined,
      delete: undefined,
      listed: true,
    });
  });

  it("shows a project bigger than one page a page at a time, reading the next after the last shown", async () => {
    const { session, asked } = fakeProjects();
    await shown(session, { ...project("user"), moreItems: true });

    const before = document.body.textContent?.includes("Desk");
    await press(button("Show more"));

    expect({
      before,
      after: document.body.textContent?.includes("Desk"),
      showMore: button("Show more"),
      asked,
    }).toStrictEqual({
      before: false,
      after: true,
      showMore: undefined,
      asked: [["items", "workflow", "wf-invoices", "2026-11-01T10:00:00.000Z"]],
    });
  });

  it("moves on past a page made only of items shown already", async () => {
    const { session, asked } = fakeProjects([
      { items: [invoicesMoved], more: true },
      { items: [desk], more: false },
    ]);
    await shown(session, { ...project("user"), moreItems: true });

    await press(button("Show more"));
    await press(button("Show more"));

    expect({
      desk: document.body.textContent?.includes("Desk"),
      invoicesShown: [...document.querySelectorAll("li")].filter((row) =>
        row.textContent?.includes("Invoices")
      ).length,
      asked,
    }).toStrictEqual({
      desk: true,
      invoicesShown: 1,
      asked: [
        ["items", "workflow", "wf-invoices", "2026-11-01T10:00:00.000Z"],
        ["items", "workflow", "wf-invoices", "2026-11-01T12:00:00.000Z"],
      ],
    });
  });
});
