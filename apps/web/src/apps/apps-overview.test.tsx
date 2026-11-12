// @vitest-environment happy-dom
import type { AppOverview } from "@grasp-os/shared/apps";
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

import { AppsOverview } from "./apps-overview.tsx";

// The Apps page as people read it, from the Apps core lists
// (`apps.overview`): each App one card that opens the live App, however
// many pages it has, the newest first, with where it stands; a search
// over their names; Make something for who builds.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** An App made at `createdAt`, live with pages or not yet, archived or not. */
const overview = (
  name: string,
  createdAt: string,
  pages: boolean,
  archived = false
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
    role: "builder",
  },
  contents: {
    version: pages ? 1 : null,
    pages,
  },
});

/** The Apps page for someone who `builds` or not, listing `listed`. */
const shown = async (listed: AppOverview[], builds = true): Promise<void> => {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <AppsOverview builds={builds} listed={listed} />,
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

/** Each card's name, where it leads and the status it shows. */
const cards = () =>
  [...document.querySelectorAll('ul[aria-label="Apps"] > li')].map((card) => ({
    name: card.querySelector("a")?.textContent,
    href: card.querySelector("a")?.getAttribute("href"),
    status: card.querySelector('[data-slot="badge"]')?.textContent,
  }));

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
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("lists each App once, the newest first, with where it stands, each opening the live App", async () => {
    const invoices = overview("Invoices", "2026-10-01T08:00:00.000Z", true);
    const holidays = overview("Holidays", "2026-10-20T08:00:00.000Z", false);
    const old = overview("Old desk", "2026-09-01T08:00:00.000Z", true, true);
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

  it("offers Make something to who builds alone, also before there is any App, and tells someone who doesn't build where Apps shared with them show", async () => {
    await shown([], true);
    const builder = {
      makeLink: makeLink(),
      said: document.body.textContent.includes("No Apps yet"),
    };
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await shown([], false);

    const user = {
      makeLink: makeLink(),
      said: document.body.textContent.includes(
        "The Apps your colleagues share with you show here."
      ),
    };

    expect({ builder, user }).toStrictEqual({
      builder: { makeLink: "/?make=app", said: true },
      user: { makeLink: undefined, said: true },
    });
  });
});
