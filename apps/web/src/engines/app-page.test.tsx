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

/** The live App with `screens`, as `viewer` sees it. */
const shown = async (
  screens: string[],
  { role, staff }: { role: ViewedApp["role"]; staff: boolean }
): Promise<void> => {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <AppPage
          app={appAs(role)}
          contents={{ version: 1, screens }}
          fullPage={null}
          identity={{ staff }}
          open={screens[0]}
        >
          <p>The screen</p>
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
      await shown(["home"], viewer);
      edit[who] = linkTo("Edit");
      takenDown();
    }

    expect(edit).toStrictEqual({
      builder: "/apps/invoice-desk/edit",
      user: undefined,
      staff: undefined,
    });
  });

  it("shows an App with two screens as one App with two pages, the open one marked, and the open one under the bar", async () => {
    await shown(["home", "invoices"], user);

    const pages = document.querySelector('nav[aria-label="Pages"]');
    expect({
      heading: [...document.querySelectorAll("h1")].map(
        (each) => each.textContent
      ),
      pages: [...(pages?.querySelectorAll("a") ?? [])].map((link) => ({
        name: link.textContent,
        open: link.getAttribute("aria-current") === "page",
      })),
      screen: document.body.textContent.includes("The screen"),
    }).toStrictEqual({
      heading: ["Invoices"],
      pages: [
        { name: "home", open: true },
        { name: "invoices", open: false },
      ],
      screen: true,
    });
  });

  it("says an App with no page has nothing to open, with the way to build it for its builder alone", async () => {
    await shown([], builder);
    const forBuilder = {
      said: document.body.textContent.includes("No page yet"),
      build: linkTo("Build it"),
    };
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await shown([], user);

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
