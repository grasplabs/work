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
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { AppsOverview } from "./apps-overview.tsx";

// The Apps page as people read it, from the Apps core lists
// (`apps.overview`), faked at the RPC boundary: each App one card that
// opens the App, the newest first, with where it stands; its window runs
// the App's first page only while the card is on screen; its menu opens
// it, leads to its settings and lets its builders archive and restore it;
// a search over their names; Make something for who builds.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** The browser's IntersectionObserver, as the test moves cards on and off screen. */
const watched = new Map<Element, (onScreen: boolean) => void>();

class FakeObserver {
  readonly #seen: (entries: { isIntersecting: boolean }[]) => void;
  readonly #elements = new Set<Element>();

  constructor(seen: (entries: { isIntersecting: boolean }[]) => void) {
    this.#seen = seen;
  }

  observe(element: Element): void {
    this.#elements.add(element);
    watched.set(element, (isIntersecting) => {
      this.#seen([{ isIntersecting }]);
    });
  }

  disconnect(): void {
    for (const element of this.#elements) {
      watched.delete(element);
    }
    this.#elements.clear();
  }
}

const realObserver: unknown = Reflect.get(globalThis, "IntersectionObserver");

/** An App made at `createdAt`, live with pages or not yet, archived or not. */
const overview = (
  name: string,
  createdAt: string,
  pages: boolean,
  {
    archived = false,
    role = "builder",
  }: { archived?: boolean; role?: "user" | "builder" } = {}
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
): Pick<Identity, "role" | "staff"> => ({
  role,
  staff: false,
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

/** The Apps page for someone with `role`, listing `listed` as core keeps them; what core was asked. */
const shown = async (
  listed: AppOverview[],
  role: Identity["role"] = "builder"
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
      <AppsOverview listed={loaded} viewer={viewerOf(role)} />
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

/** Every App on the page: its card and where it stands. */
const places = (): Element[] => [
  ...document.querySelectorAll('section[aria-label="Apps"] > div'),
];

/** Each card's name, where it leads and the status it shows. */
const cards = () =>
  places().map((place) => ({
    name: place.querySelector("a")?.textContent,
    href: place.querySelector("a")?.getAttribute("href"),
    status: place.querySelector('[data-slot="badge"]')?.textContent,
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

/** Scrolls the card of `name` on or off the screen. */
const scroll = async (name: string, onScreen: boolean): Promise<void> => {
  await act(async () => {
    watched.get(placeOf(name))?.(onScreen);
    await Promise.resolve();
  });
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
    .find((link) => link.textContent === "Make something")
    ?.getAttribute("href");

describe(AppsOverview, () => {
  beforeEach(() => {
    Reflect.set(globalThis, "IntersectionObserver", FakeObserver);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    watched.clear();
    Reflect.set(globalThis, "IntersectionObserver", realObserver);
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

  it("runs an App's first page in its window only while its card is on screen", async () => {
    const invoices = overview("Invoices", "2026-10-01T08:00:00.000Z", true);
    const holidays = overview("Holidays", "2026-10-20T08:00:00.000Z", true);
    await shown([invoices, holidays]);
    const before = windowOf("Invoices");
    await scroll("Invoices", true);
    const onScreen = {
      invoices: windowOf("Invoices"),
      holidays: windowOf("Holidays"),
    };
    await scroll("Invoices", false);

    expect({ before, onScreen, left: windowOf("Invoices") }).toStrictEqual({
      before: { runs: null, says: null },
      onScreen: {
        invoices: { runs: `/apps/${invoices.app.id}/full`, says: null },
        holidays: { runs: null, says: null },
      },
      left: { runs: null, says: null },
    });
  });

  it("keeps the window quiet for an App with no page to run or put away, on screen too", async () => {
    await shown([
      overview("Holidays", "2026-10-20T08:00:00.000Z", false),
      overview("Old desk", "2026-09-01T08:00:00.000Z", true, {
        archived: true,
      }),
    ]);
    await scroll("Holidays", true);
    await scroll("Old desk", true);

    expect({
      draft: windowOf("Holidays"),
      archived: windowOf("Old desk"),
    }).toStrictEqual({
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

  it("offers Make something to who builds alone, also before there is any App, and tells only who builds what to do", async () => {
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
