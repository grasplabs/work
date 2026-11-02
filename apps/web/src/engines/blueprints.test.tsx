// @vitest-environment happy-dom
import type { Blueprint, FromBlueprint } from "@grasp-os/shared/apps";
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

import { formatDate } from "../format.ts";
import { SaveAsBlueprint, StartFromBlueprint } from "./blueprints.tsx";

// Blueprints against core's `apps.blueprints` as the page reaches it over
// RPC (the boundary from the web app), faked as a list core keeps:
// starting from one makes an App and opens it, removing one takes it off
// the list, and saving an App marks its current version.

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

const crm: Blueprint = {
  id: blueprintIdSchema.parse("blueprint-crm"),
  name: "CRM",
  description: "",
  app: null,
  version: null,
  markedBy: null,
  markedAt,
  permissions: [],
};

/** Core's blueprints: the list it keeps, and what was asked of it. */
const fakeBlueprints = (listed: Blueprint[]) => {
  const calls: string[] = [];
  let kept = [...listed];
  return {
    calls,
    blueprints: {
      list: async (): Promise<Blueprint[]> => {
        await Promise.resolve();
        return kept;
      },
      // Only the new App's ID: all the page reads of what core made.
      create: async (id: string, input: FromBlueprint) => {
        calls.push(`create ${id} ${input.name}: ${input.description ?? ""}`);
        await Promise.resolve();
        return { app: { id: "app-new" } };
      },
      unmark: async (id: string) => {
        calls.push(`unmark ${id}`);
        kept = kept.filter((blueprint) => blueprint.id !== id);
        await Promise.resolve();
      },
      mark: async (app: string, version: number): Promise<Blueprint> => {
        calls.push(`mark ${app} ${version}`);
        await Promise.resolve();
        return { ...invoices, app: appIdSchema.parse(app), version };
      },
    },
  };
};

let root: Root | undefined;

/** `page` at /start, against `blueprints`; a domain's page says which it is. */
const opened = async (
  blueprints: ReturnType<typeof fakeBlueprints>["blueprints"],
  page: (listed: Blueprint[]) => ReactElement
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
    loader: async () => await blueprints.list(),
    component: () => page(start.useLoaderData()),
  });
  const domain = createRoute({
    getParentRoute: () => rootRoute,
    path: "/domains/$engine",
    component: () => <h1>A domain</h1>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([start, domain]),
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

/** What each blueprint's card says. */
const cards = (): string[] =>
  [...document.querySelectorAll('ul[aria-label="Blueprints"] > li')].map(
    (card) => card.textContent ?? ""
  );

const people = new Map([["user-ada", "Ada Lovelace"]]);

const picker = (listed: Blueprint[]) => (
  <StartFromBlueprint blueprints={listed} people={people} />
);

describe("blueprints", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("starts a new app from a blueprint, named as it is, and opens it", async () => {
    const { calls, blueprints } = fakeBlueprints([invoices, crm]);
    const router = await opened(blueprints, picker);

    await click("Start from a blueprint");
    const shown = cards();
    await click("Start from Invoices");

    expect({
      shown,
      calls,
      at: router.state.location.pathname,
      heading: document.querySelector("h1")?.textContent,
    }).toStrictEqual({
      shown: [
        `InvoicesOpen invoices and who chases themSaved by Ada Lovelace on ${formatDate(markedAt)}`,
        "CRMComes with Grasp",
      ],
      calls: [
        "create blueprint-invoices Invoices: Open invoices and who chases them",
      ],
      at: "/domains/app-new",
      heading: "A domain",
    });
  });

  it("removes a saved blueprint from the list, and never offers to remove a built-in", async () => {
    const { calls, blueprints } = fakeBlueprints([invoices, crm]);
    await opened(blueprints, picker);

    await click("Start from a blueprint");
    const removable = [...document.querySelectorAll("button")]
      .map((each) => each.getAttribute("aria-label"))
      .filter((label) => label?.startsWith("Remove") === true);
    await click("Remove the blueprint Invoices");

    expect({ removable, calls, left: cards() }).toStrictEqual({
      removable: ["Remove the blueprint Invoices"],
      calls: ["unmark blueprint-invoices"],
      left: ["CRMComes with Grasp"],
    });
  });

  it("saves an app's current version as a blueprint", async () => {
    const { calls, blueprints } = fakeBlueprints([]);
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
