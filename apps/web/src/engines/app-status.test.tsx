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
import type { AnyRouter } from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { StatusActions, StatusBadge } from "./app-status.tsx";

// A domain's status controls against core's `apps` as the page reaches it
// over RPC (the boundary from the web app), faked: each control moves the
// domain only along what core allows from where it is, the page reads it
// again afterwards, archiving asks first, and what core refuses is said.

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
    blueprint: null,
    currentVersion,
    pendingVersion: null,
    status,
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
    // This test's own router, never the app's registered route tree.
    const loaded: unknown = useRouterState<AnyRouter>({
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

/** The buttons shown, by their text, the dialog's included. */
const buttons = (): string[] =>
  [...document.querySelectorAll("button")].map(
    (each) => each.textContent?.trim() ?? ""
  );

const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === name
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
    const draft = shown();

    await click("Publish");

    expect({ draft, published: shown(), calls }).toStrictEqual({
      draft: {
        status: "Draft",
        buttons: ["Publish", "Archive"],
        refused: null,
      },
      published: {
        status: "Published",
        buttons: ["Unpublish", "Archive"],
        refused: null,
      },
      calls: ["publish"],
    });
  });

  it("archives only once asked and confirmed, then offers a restore alone", async () => {
    const { calls, apps } = fakeApps("published");
    await opened(apps);

    await click("Archive");
    const asked = buttons();
    await click("Cancel");
    const afterCancel = { ...shown(), calls: [...calls] };
    await click("Archive");
    // The dialog's own Archive, after the bar's.
    await act(async () => {
      [...document.querySelectorAll("button")]
        .findLast((each) => each.textContent?.trim() === "Archive")
        ?.click();
      await Promise.resolve();
    });
    await settled();
    const archived = shown();
    await click("Restore");

    expect({
      asked,
      afterCancel,
      archived,
      restored: shown(),
      calls,
    }).toStrictEqual({
      asked: ["Unpublish", "Archive", "Cancel", "Archive"],
      afterCancel: {
        status: "Published",
        buttons: ["Unpublish", "Archive"],
        refused: null,
        calls: [],
      },
      archived: { status: "Archived", buttons: ["Restore"], refused: null },
      restored: {
        status: "Draft",
        buttons: ["Publish", "Archive"],
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
      buttons: ["Publish", "Archive"],
      refused: "Only the domain's builders can do that.",
    });
  });

  it("doesn't offer to publish a domain with no version to run", async () => {
    const { apps } = fakeApps("draft", { currentVersion: null });
    await opened(apps);

    expect(button("Publish").disabled).toBeTruthy();
  });
});
