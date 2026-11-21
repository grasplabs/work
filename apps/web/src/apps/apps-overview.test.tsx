// @vitest-environment happy-dom
import type { App, AppOverview } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
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

import { AppsOverview } from "./apps-overview.tsx";

// The Apps page as people read it, from the Apps core lists
// (`apps.overview`), faked at the RPC boundary: each App one card that
// opens the App, the newest first, with where it stands; its window runs
// no App; its menu opens
// it, leads to its settings and lets its builders archive and restore it;
// the Apps in three tabs, the person's own, shared with them by name and
// the company's; a search over their names; Build new app for who builds.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** An App made at `createdAt`, live with pages or not yet, archived or not. */
const overview = (
  name: string,
  createdAt: string,
  pages: boolean,
  {
    archived = false,
    role = "builder",
    owner = "user-1",
  }: { archived?: boolean; role?: "user" | "builder"; owner?: string } = {}
): AppOverview => ({
  app: {
    id: appIdSchema.parse(crypto.randomUUID()),
    name,
    description: "",
    owner,
    responsible: owner,
    audience: null,
    process: null,
    blueprint: null,
    currentVersion: pages ? 1 : null,
    liveLabel: pages ? "26.11.1" : null,
    archived,
    link: null,
    createdAt,
    role,
  },
  contents: {
    version: pages ? 1 : null,
    pages,
  },
});

const viewerOf = (
  role: Identity["role"]
): Pick<Identity, "role" | "staff" | "userId"> => ({
  role,
  staff: false,
  userId: "user-1",
});

const isListed = (data: unknown): data is AppOverview[] => Array.isArray(data);

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

/**
 * The Apps page for someone with `role`, listing `listed` as core keeps
 * them, those of `shared` shared with them by name; what core was asked.
 */
const shown = async (
  listed: AppOverview[],
  role: Identity["role"] = "builder",
  shared: readonly string[] = []
): Promise<string[]> => {
  const calls: string[] = [];
  let apps = listed;
  const put = (id: string, archived: boolean): App => {
    apps = apps.map((each) =>
      each.app.id === id ? { ...each, app: { ...each.app, archived } } : each
    );
    const found = apps.find((each) => each.app.id === id);
    if (found === undefined) {
      throw new Error("No such App");
    }
    return found.app;
  };
  const session = {
    apps: {
      archive: async (id: string): Promise<App> => {
        calls.push(`archive ${id}`);
        return await Promise.resolve(put(id, true));
      },
      restore: async (id: string): Promise<App> => {
        calls.push(`restore ${id}`);
        return await Promise.resolve(put(id, false));
      },
    },
  };
  const core = {
    withSession: async <T,>(
      action: (given: typeof session) => Promise<T>
    ): Promise<T> => await action(session),
  };
  const rootRoute = createRootRoute({
    loader: async () => await Promise.resolve(apps),
  });
  const Page = () => {
    const loaded: unknown = useRouterState<AnyRouter>({
      select: ({ matches }) => matches.at(0)?.loaderData,
    });
    return isListed(loaded) ? (
      <AppsOverview listed={loaded} shared={shared} viewer={viewerOf(role)} />
    ) : null;
  };
  rootRoute.update({ component: Page });
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
  await settled();
  return calls;
};

/** Every App in the tab shown: its card. */
const places = (): Element[] => [
  ...document.querySelectorAll('[role="tabpanel"] [data-slot="app-card"]'),
];

/** The tabs: what each says, and whether it is the one shown. */
const tabs = () =>
  [...document.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => ({
    says: tab.textContent.trim(),
    shown: tab.getAttribute("aria-selected") === "true",
  }));

/** Shows the tab that says `label`. */
const showTab = async (label: string): Promise<void> => {
  const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (each) => each.textContent.trim() === label
  );
  if (tab === undefined) {
    throw new Error(`No tab ${label}`);
  }
  await act(async () => {
    tab.click();
    await Promise.resolve();
  });
};

/** Each card's name, where it leads and the status it shows. */
const cards = () =>
  places().map((place) => ({
    name: place.querySelector("a")?.textContent,
    href: place.querySelector("a")?.getAttribute("href"),
    status: place.querySelector('[data-slot="app-card-meta"]')?.textContent,
  }));

/** The place of the App called `name`. */
const placeOf = (name: string): Element => {
  const found = places().find(
    (place) => place.querySelector("a")?.textContent === name
  );
  if (found === undefined) {
    throw new Error(`No App ${name}`);
  }
  return found;
};

/** What runs in the window of `name`: the address of the App in it, or what it says instead. */
const windowOf = (name: string) => {
  const place = placeOf(name);
  return {
    runs: place.querySelector("iframe")?.getAttribute("src") ?? null,
    says:
      place.querySelector('[data-slot="app-card-window"] p')?.textContent ??
      null,
  };
};

/** Opens the "…" of `name`, and gives its items: what each says and where it leads. */
const menuOf = async (name: string) => {
  const more = placeOf(name).querySelector<HTMLButtonElement>("button");
  await act(async () => {
    more?.click();
    await Promise.resolve();
  });
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
};

const said = (items: readonly HTMLElement[]) =>
  items.map((item) => ({
    says: item.textContent.trim(),
    to: item.getAttribute("href"),
  }));

/** Chooses `label` from the open menu. */
const choose = async (
  items: readonly HTMLElement[],
  label: string
): Promise<void> => {
  const item = items.find((each) => each.textContent.trim() === label);
  if (item === undefined) {
    throw new Error(`No ${label}`);
  }
  await act(async () => {
    item.click();
    await Promise.resolve();
  });
  await settled();
};

/** Presses the dialog's button `label`. */
const answer = async (label: string): Promise<void> => {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[role="alertdialog"] button'
    ),
  ].find((each) => each.textContent.trim() === label);
  if (found === undefined) {
    throw new Error(`No answer ${label}`);
  }
  await act(async () => {
    found.click();
    await Promise.resolve();
  });
  await settled();
};

/** Types `value` into the search, as React hears a person type. */
const search = async (value: string): Promise<void> => {
  const box = document.querySelector<HTMLInputElement>(
    'input[aria-label="Search the Apps"]'
  );
  if (box === null) {
    throw new TypeError("No search");
  }
  await act(async () => {
    const prototype = Reflect.getPrototypeOf(box) ?? {};
    Reflect.getOwnPropertyDescriptor(prototype, "value")?.set?.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

const makeLink = (): string | null | undefined =>
  [...document.querySelectorAll("a")]
    .find((link) => link.textContent === "Build new app")
    ?.getAttribute("href");

describe(AppsOverview, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("lists each App once, the newest first, with where it stands, each opening the App", async () => {
    const invoices = overview("Invoices", "2026-10-01T08:00:00.000Z", true);
    const holidays = overview("Holidays", "2026-10-20T08:00:00.000Z", false);
    const old = overview("Old desk", "2026-09-01T08:00:00.000Z", true, {
      archived: true,
    });
    await shown([invoices, old, holidays]);

    expect({ cards: cards(), makeLink: makeLink() }).toStrictEqual({
      cards: [
        {
          name: "Holidays",
          href: `/apps/${holidays.app.id}`,
          status: "Only you see this",
        },
        {
          name: "Invoices",
          href: `/apps/${invoices.app.id}`,
          status: "Your team uses it",
        },
        { name: "Old desk", href: `/apps/${old.app.id}`, status: "Archived" },
      ],
      makeLink: "/?make=app",
    });
  });

  it("keeps every App's window quiet, running no App in it, whether it has a page to run or not", async () => {
    await shown([
      overview("Invoices", "2026-10-01T08:00:00.000Z", true),
      overview("Holidays", "2026-10-20T08:00:00.000Z", false),
      overview("Old desk", "2026-09-01T08:00:00.000Z", true, {
        archived: true,
      }),
    ]);
    expect({
      live: windowOf("Invoices"),
      draft: windowOf("Holidays"),
      archived: windowOf("Old desk"),
    }).toStrictEqual({
      live: { runs: null, says: "No preview yet" },
      draft: { runs: null, says: "No preview yet" },
      archived: { runs: null, says: "No preview yet" },
    });
  });

  it("opens the App, its full page and its settings from a card's menu by links, so they open in a new tab too", async () => {
    const invoices = overview("Invoices", "2026-10-01T08:00:00.000Z", true, {
      role: "user",
    });
    await shown([invoices], "user");

    expect(said(await menuOf("Invoices"))).toStrictEqual([
      { says: "Open", to: `/apps/${invoices.app.id}` },
      { says: "Open full page", to: `/apps/${invoices.app.id}/full` },
      { says: "Settings", to: `/apps/${invoices.app.id}/settings` },
    ]);
  });

  it("archives an App from its card's menu once its builder confirms, and restores it from there", async () => {
    const invoices = overview("Invoices", "2026-10-01T08:00:00.000Z", true);
    const calls = await shown([invoices]);
    await choose(await menuOf("Invoices"), "Archive");
    const asked = {
      calls: [...calls],
      asks: document.querySelector('[role="alertdialog"] h2')?.textContent,
    };
    await answer("Archive");
    const archived = cards();
    await choose(await menuOf("Invoices"), "Restore");

    expect({ asked, archived, calls, restored: cards() }).toStrictEqual({
      asked: { calls: [], asks: "Archive Invoices?" },
      archived: [
        {
          name: "Invoices",
          href: `/apps/${invoices.app.id}`,
          status: "Archived",
        },
      ],
      calls: [`archive ${invoices.app.id}`, `restore ${invoices.app.id}`],
      restored: [
        {
          name: "Invoices",
          href: `/apps/${invoices.app.id}`,
          status: "Your team uses it",
        },
      ],
    });
  });

  it("sorts the Apps into the person's own, those shared with them by name and the company's, opening on the first that has any", async () => {
    const shared = overview("Expenses", "2026-10-01T08:00:00.000Z", true, {
      owner: "user-2",
      role: "user",
    });
    const company = overview("Desk", "2026-10-02T08:00:00.000Z", true, {
      owner: "user-3",
      role: "user",
    });
    await shown([shared, company], "builder", [shared.app.id]);
    const opened = { tabs: tabs(), cards: cards().map(({ name }) => name) };
    await showTab("Company apps");
    const companyCards = cards().map(({ name }) => name);
    await showTab("My apps");

    expect({
      opened,
      company: companyCards,
      mine: cards(),
      said: document.body.textContent.includes(
        "Apps you build or answer for stand here."
      ),
    }).toStrictEqual({
      opened: {
        tabs: [
          { says: "My apps", shown: false },
          { says: "Shared apps", shown: true },
          { says: "Company apps", shown: false },
        ],
        cards: ["Expenses"],
      },
      company: ["Desk"],
      mine: [],
      said: true,
    });
  });

  it("narrows the Apps to those whose name has what is searched, and says when none has", async () => {
    await shown([
      overview("Invoices", "2026-10-01T08:00:00.000Z", true),
      overview("Invoice archive", "2026-10-02T08:00:00.000Z", true),
      overview("Holidays", "2026-10-03T08:00:00.000Z", true),
    ]);

    await search("invoice");
    const found = cards().map(({ name }) => name);
    await search("payroll");

    expect({
      found,
      none: cards(),
      said: document.body.textContent.includes("No App is called “payroll”"),
    }).toStrictEqual({
      found: ["Invoice archive", "Invoices"],
      none: [],
      said: true,
    });
  });

  it("offers Build new app to who builds alone, also before there is any App, and tells only who builds what to do", async () => {
    await shown([], "builder");
    const builder = {
      makeLink: makeLink(),
      said: document.body.textContent.includes("No Apps yet"),
      told: document.body.textContent.includes(
        "Say what you want to build, and Grasp builds it."
      ),
    };
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await shown([], "user");

    const user = {
      makeLink: makeLink(),
      said: document.body.textContent.includes("No Apps yet"),
      told: document.body.textContent.includes(
        "Say what you want to build, and Grasp builds it."
      ),
    };

    expect({ builder, user }).toStrictEqual({
      builder: { makeLink: "/?make=app", said: true, told: true },
      user: { makeLink: undefined, said: true, told: false },
    });
  });
});
