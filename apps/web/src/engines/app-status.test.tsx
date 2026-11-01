// @vitest-environment happy-dom
import type { App, AppStatus } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
  useRouterState,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { StatusActions, StatusBadge } from "./app-status.tsx";

// A domain's status controls against core's `apps` as the page reaches it
// over RPC (the boundary from the web app), faked: each control moves the
// domain only along what core allows from where it is, the page reads it
// again afterwards, archiving asks first, and what core refuses is said.
// Publish and Restore stand on the bar; Unpublish and Archive are under
// its "…" menu.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Transition = "publish" | "unpublish" | "archive" | "restore";

/** Where each transition goes, from where core lets it start. */
const moves: Record<Transition, { from: AppStatus[]; to: AppStatus }> = {
  publish: { from: ["draft"], to: "published" },
  unpublish: { from: ["published"], to: "draft" },
  archive: { from: ["draft", "published"], to: "archived" },
  restore: { from: ["archived"], to: "draft" },
};

/** Core's `apps` for one domain, refusing `refusing` with core's reason. */
const fakeApps = (
  status: AppStatus,
  {
    currentVersion = 1,
    refusing,
  }: { currentVersion?: number | null; refusing?: Transition } = {}
) => {
  const calls: Transition[] = [];
  let app: App = {
    id: appIdSchema.parse(crypto.randomUUID()),
    name: "Invoices",
    description: "",
    owner: "user-1",
    responsible: "user-1",
    audience: null,
    process: null,
    blueprint: null,
    currentVersion,
    pendingVersion: null,
    status,
    link: null,
    createdAt: "2026-10-20T08:00:00.000Z",
  };
  const move = async (transition: Transition): Promise<App> => {
    calls.push(transition);
    await Promise.resolve();
    if (transition === refusing) {
      throw new Error("Only the domain's builders can do that.");
    }
    if (!moves[transition].from.includes(app.status)) {
      throw new Error("The domain moved on meanwhile.");
    }
    app = { ...app, status: moves[transition].to };
    return app;
  };
  return {
    calls,
    apps: {
      get: async (): Promise<App> => await Promise.resolve(app),
      publish: async () => await move("publish"),
      unpublish: async () => await move("unpublish"),
      archive: async () => await move("archive"),
      restore: async () => await move("restore"),
    },
  };
};

let root: Root | undefined;

/** Whether the loader's data is the domain, as `fakeApps` answers it. */
const isApp = (data: unknown): data is App =>
  typeof data === "object" && data !== null && "status" in data;

/** The domain's status and its controls, as its page reads them from `apps`. */
const opened = async (
  apps: ReturnType<typeof fakeApps>["apps"]
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      action: (session: { apps: typeof apps }) => Promise<T>
    ): Promise<T> => await action({ apps }),
  };
  const rootRoute = createRootRoute({
    loader: async () => await apps.get(),
  });
  // The bar as a page has it: the domain as its loader read it last.
  const DomainBar = () => {
    const loaded: unknown = useRouterState({
      select: ({ matches }) => matches.at(0)?.loaderData,
    });
    if (!isApp(loaded)) {
      return null;
    }
    return (
      <div>
        <StatusBadge status={loaded.status} />
        <StatusActions app={loaded} />
      </div>
    );
  };
  rootRoute.update({ component: DomainBar });
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
        <RouterProvider router={router} />
      </I18nProvider>
    );
    await router.load();
  });
};

/** Lets every pending promise and render settle, the page's reload too. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 10);
    await promise;
  });
};

/** The "…" menu's button, by its label. */
const more = "More for this domain";

/** What a button or menu item is called: its text, or its label without one. */
const nameOf = (element: HTMLElement): string => {
  const text = element.textContent?.trim() ?? "";
  return text === "" ? (element.getAttribute("aria-label") ?? "") : text;
};

/** The buttons shown, by their name, the dialog's included. */
const buttons = (): string[] =>
  [...document.querySelectorAll("button")].map(nameOf);

/** The items of the open "…" menu, by their text. */
const items = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
];

const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) => nameOf(each) === name
  );
  if (found === undefined) {
    throw new Error(`No button ${name}`);
  }
  return found;
};

const press = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

const click = async (name: string): Promise<void> => {
  await press(button(name));
};

/** Opens the "…" menu and says what it holds. */
const openMenu = async (): Promise<string[]> => {
  if (button(more).getAttribute("aria-expanded") !== "true") {
    await click(more);
  }
  return items().map(nameOf);
};

/** Chooses `name` from the "…" menu. */
const choose = async (name: string): Promise<void> => {
  await openMenu();
  const found = items().find((each) => nameOf(each) === name);
  if (found === undefined) {
    throw new Error(`No menu item ${name}`);
  }
  await press(found);
};

/** What the page shows: the status badge, the buttons, and any refusal. */
const shown = () => ({
  status: document.querySelector('[data-slot="badge"]')?.textContent,
  buttons: buttons(),
  refused: document.querySelector('[role="alert"]')?.textContent ?? null,
});

describe("a domain's status controls", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("publishes a draft, and offers to take it back once the page reads it published", async () => {
    const { calls, apps } = fakeApps("draft");
    await opened(apps);
    const draft = { ...shown(), menu: await openMenu() };

    await click("Publish");
    const published = { ...shown(), menu: await openMenu() };
    await choose("Unpublish");

    expect({ draft, published, unpublished: shown(), calls }).toStrictEqual({
      draft: {
        status: "Draft",
        buttons: ["Publish", more],
        refused: null,
        menu: ["Archive"],
      },
      published: {
        status: "Published",
        buttons: [more],
        refused: null,
        menu: ["Unpublish", "Archive"],
      },
      unpublished: {
        status: "Draft",
        buttons: ["Publish", more],
        refused: null,
      },
      calls: ["publish", "unpublish"],
    });
  });

  it("archives only once asked and confirmed, then offers a restore alone", async () => {
    const { calls, apps } = fakeApps("published");
    await opened(apps);

    await choose("Archive");
    const asked = buttons();
    await click("Cancel");
    const afterCancel = { ...shown(), calls: [...calls] };
    await choose("Archive");
    await click("Archive");
    const archived = shown();
    await click("Restore");

    expect({
      asked,
      afterCancel,
      archived,
      restored: shown(),
      calls,
    }).toStrictEqual({
      asked: [more, "Cancel", "Archive"],
      afterCancel: {
        status: "Published",
        buttons: [more],
        refused: null,
        calls: [],
      },
      archived: { status: "Archived", buttons: ["Restore"], refused: null },
      restored: {
        status: "Draft",
        buttons: ["Publish", more],
        refused: null,
      },
      calls: ["archive", "restore"],
    });
  });

  it("says why core refused, leaving the domain as it was", async () => {
    const { apps } = fakeApps("draft", { refusing: "publish" });
    await opened(apps);

    await click("Publish");

    expect(shown()).toStrictEqual({
      status: "Draft",
      buttons: ["Publish", more],
      refused: "Only the domain's builders can do that.",
    });
  });

  it("doesn't offer to publish a domain with no version to run", async () => {
    const { apps } = fakeApps("draft", { currentVersion: null });
    await opened(apps);

    expect(button("Publish").disabled).toBeTruthy();
  });
});
