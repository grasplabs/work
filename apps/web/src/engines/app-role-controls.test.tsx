// @vitest-environment happy-dom
import type { ViewedApp } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { AppPage } from "./app-page.tsx";
import { AppStatusControls } from "./app-status.tsx";

// Who an App's pages offer its changes to (app-role.ts, `buildsApp`): its
// builders, by their role in that App, never by their role in the
// organization. An organization's builder who only uses this App gets no
// controls on its page or the domain's, nor does Grasp staff, whom core
// counts a builder of every App. Core refuses them all the same; this is
// what the page offers.

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

/** A draft App, as someone with `role` in it reads it. */
const appAs = (role: ViewedApp["role"]): ViewedApp => ({
  id: appIdSchema.parse("invoice-desk"),
  name: "Invoice desk",
  description: "",
  owner: "owner",
  responsible: "owner",
  audience: null,
  blueprint: null,
  currentVersion: null,
  pendingVersion: null,
  status: "draft",
  createdAt: "2026-10-27T10:00:00.000Z",
  role,
});

/** The names of the buttons `page` shows, on a page of its own. */
const buttonsOf = async (page: ReactNode): Promise<string[]> => {
  const rootRoute = createRootRoute({ component: Outlet });
  const here = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: (): ReactNode => page,
  });
  const settings = createRoute({
    getParentRoute: () => rootRoute,
    path: "/domains/$engine",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([here, settings]),
    history: createMemoryHistory(),
    // Nothing here calls core: the controls only show.
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
  const names = [...document.querySelectorAll("button")].map(
    (each) => each.textContent?.trim() ?? ""
  );
  takenDown();
  return names;
};

/** Someone who builds the App; who only uses it; Grasp staff. */
const builder = { role: "builder", staff: false } as const;
const user = { role: "user", staff: false } as const;
const staff = { role: "builder", staff: true } as const;

/** The App's own page, as `viewer` sees it. */
const appPageFor = async ({
  role,
  staff: isStaff,
}: {
  role: ViewedApp["role"];
  staff: boolean;
}): Promise<boolean> => {
  const names = await buttonsOf(
    <AppPage
      app={appAs(role)}
      contents={{ version: null, screens: [], workflows: [] }}
      identity={{ staff: isStaff }}
      open={undefined}
    >
      {null}
    </AppPage>
  );
  return names.includes("Edit");
};

/** The domain page's status controls, as `viewer` sees them. */
const statusFor = async ({
  role,
  staff: isStaff,
}: {
  role: ViewedApp["role"];
  staff: boolean;
}): Promise<boolean> => {
  const names = await buttonsOf(
    <AppStatusControls app={appAs(role)} identity={{ staff: isStaff }} />
  );
  return names.includes("Archive");
};

describe("an App's changes, offered on its pages", () => {
  afterEach(takenDown);

  it("shows Edit and Publish on the App's page to its builders alone, never to a user of it or to staff", async () => {
    expect({
      builder: await appPageFor(builder),
      user: await appPageFor(user),
      staff: await appPageFor(staff),
    }).toStrictEqual({ builder: true, user: false, staff: false });
  });

  it("shows the domain's status controls to its builders alone, never to a user of it or to staff", async () => {
    expect({
      builder: await statusFor(builder),
      user: await statusFor(user),
      staff: await statusFor(staff),
    }).toStrictEqual({ builder: true, user: false, staff: false });
  });
});
