// @vitest-environment happy-dom
import type { SharedSyncPlaces } from "@grasp-os/shared/connect";
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
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { CatalogConnection } from "./integrations.ts";
import { SyncPlaces } from "./sync-places.tsx";

// The places of a shared connection an admin picks to sync into the
// Brain, on its card beside its Brain audience. These start from what an
// admin must not miss: that everyone in the audience will read everything
// in a picked place; a save that core refused looking as if it went
// through; a site's libraries told apart only by a cut name; an empty
// list looking like a failure.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const shared: CatalogConnection = {
  id: "c1",
  source: "native",
  provider: "microsoft",
  scope: "shared",
  status: "active",
  ownerUserId: null,
  connectedBy: "u1",
  connectedByName: "Ada",
  accountName: "files@acme.test",
  createdAt: "2026-10-22T08:00:00.000Z",
};

const label = "Microsoft 365 (files@acme.test)";

/** What the page asked of core, by method, and its arguments. */
type Asked = [string, ...unknown[]][];

/** The refusal's words, as core gives them. */
const refusal = "Only the company's admins pick what syncs.";

let root: Root | undefined;

/**
 * Shows the picker for `shared` with core holding `places`, and records
 * what the page asks it; `refusing` has core refuse a save.
 */
const shown = async (
  places: SharedSyncPlaces,
  refusing = false
): Promise<Asked> => {
  const held = structuredClone(places);
  const asked: Asked = [];
  const session = {
    connections: {
      syncPlaces: async (...given: unknown[]) => {
        asked.push(["syncPlaces", ...given]);
        return await Promise.resolve(structuredClone(held));
      },
      pickSyncPlaces: async (request: {
        connectionId: string;
        feed: string;
        places: string[];
      }) => {
        asked.push(["pickSyncPlaces", request]);
        await Promise.resolve();
        if (refusing) {
          throw new Error(refusal);
        }
        for (const choice of held.choices) {
          choice.picked = request.places.includes(choice.place);
        }
      },
    },
  };
  const core = {
    withSession: async <T,>(action: (given: unknown) => Promise<T>) =>
      await action(session),
  };
  const rootRoute = createRootRoute({
    component: () => <SyncPlaces connection={shared} label={label} />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
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
  await act(async () => {
    await Promise.resolve();
  });
  return asked;
};

/** Ticks the box of the place named `title`. */
const tick = async (title: string): Promise<void> => {
  const named = [...document.querySelectorAll("label")].find(
    (each) => each.textContent === title
  );
  const box = document.querySelector<HTMLElement>(
    `[id="${named?.getAttribute("for") ?? ""}"]`
  );
  await act(async () => {
    box?.click();
    await Promise.resolve();
  });
};

/** Presses the save button, and waits until `settled` holds. */
const save = async (settled: () => boolean): Promise<void> => {
  const button = [...document.querySelectorAll("button")].find(
    (each) => each.textContent === "Save the places"
  );
  await act(async () => {
    button?.click();
    await Promise.resolve();
  });
  // Each try lets React render what core answered before looking.
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    if (!settled()) {
      throw new Error("Not settled yet");
    }
  });
};

const longSite = `Sales and marketing ${"of the northern region ".repeat(14)}`;

const libraries: SharedSyncPlaces = {
  feed: "libraries",
  choices: [
    { place: "b!docs", title: "Documents", within: longSite, picked: false },
    {
      place: "b!contracts",
      title: "Contracts",
      within: longSite,
      picked: true,
    },
  ],
};

const text = (): string => document.body.textContent ?? "";

describe("picking a shared connection's places to sync", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("says before anything is picked that the audience reads everything in a picked place, and shows each place whole", async () => {
    await shown(libraries);
    expect({
      consequence: text().includes(
        `Everyone you let read ${label} in the Brain will be able to read everything in the places you pick, because the permissions in ${label} are not copied.`
      ),
      // Each library by its own name, with its site in whole beside it.
      documents: text().includes("Documents"),
      site: text().includes(longSite.trim()),
    }).toStrictEqual({ consequence: true, documents: true, site: true });
  });

  it("saves the places ticked, the whole set, and shows what core holds after", async () => {
    const asked = await shown(libraries);
    await tick("Documents");
    await tick("Contracts");
    await save(
      () => asked.filter(([method]) => method === "syncPlaces").length === 2
    );
    expect(
      asked.filter(([method]) => method === "pickSyncPlaces")
    ).toStrictEqual([
      [
        "pickSyncPlaces",
        { connectionId: "c1", feed: "libraries", places: ["b!docs"] },
      ],
    ]);
    // Read again after the save.
    expect(asked.filter(([method]) => method === "syncPlaces")).toHaveLength(2);
  });

  it("keeps a refused save's reason on the page, and the places as ticked", async () => {
    await shown(libraries, true);
    await tick("Documents");
    await save(() => document.querySelector('[role="alert"]') !== null);
    expect({
      reason: document.querySelector('[role="alert"]')?.textContent,
      stillTicked:
        document
          .querySelector('[data-slot="checkbox"][data-checked]')
          ?.parentElement?.textContent?.includes("Documents") ?? false,
    }).toStrictEqual({ reason: refusal, stillTicked: true });
  });

  it("says so when the account can open no place, rather than an empty list", async () => {
    await shown({ feed: "shared-drives", choices: [] });
    expect({
      empty: text().includes("Nothing to copy into the Brain yet"),
      saves: [...document.querySelectorAll("button")].some(
        (button) => button.textContent === "Save the places"
      ),
    }).toStrictEqual({ empty: true, saves: false });
  });
});
