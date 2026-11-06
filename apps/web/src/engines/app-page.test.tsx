// @vitest-environment happy-dom
import type { ViewedApp } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
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

import { AppPage } from "./app-page.tsx";

// The live App, as its people use it: its pages as tabs, the open one
// marked, and nothing that builds it but Edit, which opens its workspace,
// for its builders alone (by their role in this App, never Grasp staff,
// whom core counts a builder of every App). Core refuses anyone else all
// the same; this is what the page offers.

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

const appAs = (role: ViewedApp["role"]): ViewedApp => ({
  id: appIdSchema.parse("invoice-desk"),
  name: "Invoices",
  description: "",
  owner: "user-1",
  responsible: "user-1",
  audience: null,
  process: null,
  blueprint: null,
  currentVersion: 1,
  pendingVersion: null,
  status: "published",
  link: null,
  createdAt: "2026-10-20T08:00:00.000Z",
  role,
});

/** The live App, with pages to open or not, as `viewer` sees it. */
const shown = async (
  opens: boolean,
  { role, staff }: { role: ViewedApp["role"]; staff: boolean }
): Promise<void> => {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <AppPage
          app={appAs(role)}
          fullPage={null}
          identity={{ staff }}
          opens={opens}
        >
          <p>The page</p>
        </AppPage>
      ),
    }),
    history: createMemoryHistory(),
    // Nothing here calls core: the page only shows.
    context: { core: {} },
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

/** Where the page's link called `name` goes, if it has one. */
const linkTo = (name: string): string | null | undefined =>
  [...document.querySelectorAll("a")]
    .find((link) => link.textContent === name)
    ?.getAttribute("href");

const builder = { role: "builder", staff: false } as const;
const user = { role: "user", staff: false } as const;
const staff = { role: "builder", staff: true } as const;

describe(AppPage, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("offers Edit, to the App's workspace, to its builders alone, never to a user of it or to staff", async () => {
    const edit: Record<string, string | null | undefined> = {};
    for (const [who, viewer] of Object.entries({ builder, user, staff })) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      await shown(true, viewer);
      edit[who] = linkTo("Edit");
      takenDown();
    }

    expect(edit).toStrictEqual({
      builder: "/apps/invoice-desk/edit",
      user: undefined,
      staff: undefined,
    });
  });

  it("shows the App's pages under its bar, its name the heading", async () => {
    await shown(true, user);

    expect({
      heading: [...document.querySelectorAll("h1")].map(
        (each) => each.textContent
      ),
      page: document.body.textContent.includes("The page"),
    }).toStrictEqual({ heading: ["Invoices"], page: true });
  });

  it("says an App with no page has nothing to open, with the way to build it for its builder alone", async () => {
    await shown(false, builder);
    const forBuilder = {
      said: document.body.textContent.includes("No page yet"),
      build: linkTo("Build it"),
    };
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await shown(false, user);

    expect({
      forBuilder,
      forUser: {
        said: document.body.textContent.includes("No page yet"),
        build: linkTo("Build it"),
      },
    }).toStrictEqual({
      forBuilder: { said: true, build: "/apps/invoice-desk/edit" },
      forUser: { said: true, build: undefined },
    });
  });
});
