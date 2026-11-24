// @vitest-environment happy-dom
import type { Blueprint } from "@grasp-os/shared/apps";
import { appIdSchema, blueprintIdSchema } from "@grasp-os/shared/ids";
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
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { SaveAsBlueprint } from "./blueprints.tsx";

// Saving a blueprint against core's `apps.blueprints` as the page reaches
// it over RPC (the boundary from the web app), faked: saving an App marks
// its current version.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const markedAt = "2026-10-20T08:00:00.000Z";

const invoices: Blueprint = {
  id: blueprintIdSchema.parse("blueprint-invoices"),
  name: "Invoices",
  description: "Open invoices and who chases them",
  app: appIdSchema.parse("app-finance"),
  version: 4,
  markedBy: "user-ada",
  markedAt,
  permissions: [],
};

/** Core's blueprints: what was asked of it. */
const fakeBlueprints = () => {
  const calls: string[] = [];
  return {
    calls,
    blueprints: {
      mark: async (app: string, version: number): Promise<Blueprint> => {
        calls.push(`mark ${app} ${version}`);
        await Promise.resolve();
        return { ...invoices, app: appIdSchema.parse(app), version };
      },
    },
  };
};

let root: Root | undefined;

/** `page` at /start, against `blueprints`. */
const opened = async (
  blueprints: ReturnType<typeof fakeBlueprints>["blueprints"],
  page: () => ReactElement
) => {
  const core = {
    withSession: async <T,>(
      action: (session: {
        apps: { blueprints: typeof blueprints };
      }) => Promise<T>
    ): Promise<T> => await action({ apps: { blueprints } }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const start = createRoute({
    getParentRoute: () => rootRoute,
    path: "/start",
    component: page,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([start]),
    history: createMemoryHistory({ initialEntries: ["/start"] }),
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
  return router;
};

/** Lets every pending promise and render settle. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/** The button named `name`, by its label or its text. */
const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) =>
      (each.getAttribute("aria-label") ?? each.textContent?.trim()) === name
  );
  if (found === undefined) {
    throw new Error(`No button ${name}`);
  }
  return found;
};

const click = async (name: string): Promise<void> => {
  await act(async () => {
    button(name).click();
    await Promise.resolve();
  });
  await settled();
};

describe("blueprints", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("saves an app's current version as a blueprint", async () => {
    const { calls, blueprints } = fakeBlueprints();
    await opened(blueprints, () => (
      <SaveAsBlueprint app="app-finance" name="Finance" version={7} />
    ));

    await click("Save as blueprint");
    const asked = document.querySelector("h2")?.textContent;
    const saveButtons = [...document.querySelectorAll("button")].filter(
      (each) => each.textContent === "Save as blueprint"
    );
    await act(async () => {
      saveButtons.at(-1)?.click();
      await Promise.resolve();
    });
    await settled();

    expect({
      asked,
      calls,
      title: document.querySelector("h2")?.textContent,
    }).toStrictEqual({
      asked: "Save Finance as a blueprint",
      calls: ["mark app-finance 7"],
      title: "Saved as a blueprint",
    });
  });
});
