// @vitest-environment happy-dom
import type { AppOverview, AppStatus } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
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

import { AppsOverview } from "./apps-overview.tsx";

// The Apps page as people read it, from the Apps core lists
// (`apps.overview`): each App one tile that opens it, however many
// screens (pages) it has, the newest first; its pages counted, never
// listed as apps of their own. Archived Apps stay out of All, under a tab
// of their own.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** An App made at `createdAt`, standing at `status`, with `screens`. */
const overview = (
  name: string,
  createdAt: string,
  screens: string[],
  status: AppStatus = "published"
): AppOverview => ({
  app: {
    id: appIdSchema.parse(crypto.randomUUID()),
    name,
    description: "",
    owner: "user-1",
    responsible: "user-1",
    audience: null,
    process: null,
    blueprint: null,
    currentVersion: screens.length === 0 ? null : 1,
    pendingVersion: null,
    status,
    link: null,
    createdAt,
    role: "builder",
  },
  contents: {
    version: screens.length === 0 ? null : 1,
    screens,
    workflows: [],
  },
});

/** The Apps page for someone who builds, listing `listed`. */
const shown = async (listed: AppOverview[]): Promise<void> => {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <AppsOverview builds listed={listed} />,
    }),
    history: createMemoryHistory(),
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

/** What a tile says of its App's pages: one of `pageCounts`, or nothing. */
const pageCounts = ["2 pages", "1 page", "No pages yet"];

/** Each tile's name, where it leads and what it says of its pages. */
const tiles = () =>
  [...document.querySelectorAll('ul[aria-label="Apps"] > li')].map((tile) => {
    const link = tile.querySelector("a");
    return {
      name: link?.textContent,
      href: link?.getAttribute("href"),
      meta: pageCounts.find((count) => tile.textContent.includes(count)) ?? "",
    };
  });

/**
 * The Apps page listing `before` until Refresh is pressed, then `after`, as
 * a new read of the same page.
 */
const shownThenRefreshed = async (
  before: AppOverview[],
  after: AppOverview[]
): Promise<void> => {
  const Refreshing = () => {
    const [listed, setListed] = useState(before);
    return (
      <>
        <button
          onClick={() => {
            setListed(after);
          }}
          type="button"
        >
          Refresh
        </button>
        <AppsOverview builds listed={listed} />
      </>
    );
  };
  const router = createRouter({
    routeTree: createRootRoute({ component: Refreshing }),
    history: createMemoryHistory(),
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

/** Presses the button or tab whose text starts with `name`. */
const press = (name: string): void => {
  const target = [
    ...document.querySelectorAll<HTMLElement>('button, [role="tab"]'),
  ].find((each) => each.textContent.startsWith(name));
  act(() => {
    target?.click();
  });
};

describe(AppsOverview, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("lists Apps, not their screens: an App with two screens is one tile with two pages, the newest App first", async () => {
    const invoices = overview("Invoices", "2026-10-01T08:00:00.000Z", [
      "home",
      "invoice",
    ]);
    const holidays = overview("Holidays", "2026-10-20T08:00:00.000Z", [
      "requests",
    ]);
    const intake = overview("Intake", "2026-10-25T08:00:00.000Z", [], "draft");

    await shown([invoices, holidays, intake]);

    expect(tiles()).toStrictEqual([
      {
        name: "Intake",
        href: `/apps/${intake.app.id}`,
        meta: "No pages yet",
      },
      {
        name: "Holidays",
        href: `/apps/${holidays.app.id}`,
        meta: "1 page",
      },
      {
        name: "Invoices",
        href: `/apps/${invoices.app.id}`,
        meta: "2 pages",
      },
    ]);
  });

  it("keeps archived Apps out of All, under a tab of their own", async () => {
    const live = overview("Invoices", "2026-10-01T08:00:00.000Z", ["home"]);
    const put = overview(
      "Old intake",
      "2026-10-02T08:00:00.000Z",
      ["home"],
      "archived"
    );

    await shown([live, put]);
    const all = tiles().map(({ name }) => name);
    const archivedTab = [
      ...document.querySelectorAll<HTMLElement>('[role="tab"]'),
    ].find((tab) => tab.textContent.startsWith("Archived"));
    act(() => {
      archivedTab?.click();
    });

    expect({
      all,
      archived: tiles().map(({ name }) => name),
    }).toStrictEqual({ all: ["Invoices"], archived: ["Old intake"] });
  });

  it("shows every App again when the status picked holds none after a refresh", async () => {
    const invoices = overview("Invoices", "2026-10-01T08:00:00.000Z", ["home"]);
    const intake = overview(
      "Intake",
      "2026-10-02T08:00:00.000Z",
      ["home"],
      "draft"
    );
    await shownThenRefreshed(
      [invoices, intake],
      // The draft was published meanwhile.
      [invoices, { ...intake, app: { ...intake.app, status: "published" } }]
    );
    press("Draft");
    const drafts = tiles().map(({ name }) => name);

    press("Refresh");

    expect({
      drafts,
      after: tiles().map(({ name }) => name),
      tabs: document.querySelectorAll('[role="tab"]').length,
    }).toStrictEqual({
      drafts: ["Intake"],
      after: ["Intake", "Invoices"],
      tabs: 0,
    });
  });

  it("keeps archived Apps under their tab when every App is archived", async () => {
    await shown([
      overview("Old intake", "2026-10-02T08:00:00.000Z", ["home"], "archived"),
    ]);
    const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')];
    const all = tiles().map(({ name }) => name);
    act(() => {
      tabs.find((tab) => tab.textContent.startsWith("Archived"))?.click();
    });

    expect({
      tabs: tabs.map((tab) => tab.textContent),
      all,
      archived: tiles().map(({ name }) => name),
    }).toStrictEqual({
      tabs: ["All0", "Archived1"],
      all: [],
      archived: ["Old intake"],
    });
  });
});
