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
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { AppsOverview } from "./apps-overview.tsx";

// The Apps page as people read it, from the Apps core lists
// (`apps.overview`): each App one card that opens the live App, however
// many pages it has, the newest first, with where it stands; a search
// over their names; New App for who builds.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** An App made at `createdAt`, standing at `status`, with pages or not. */
const overview = (
  name: string,
  createdAt: string,
  pages: boolean,
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
    currentVersion: pages ? 1 : null,
    pendingVersion: null,
    status,
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

const newApp = (): string | null | undefined =>
  [...document.querySelectorAll("a")]
    .find((link) => link.textContent === "New App")
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
    const invoices = overview(
      "Invoices",
      "2026-10-01T08:00:00.000Z",
      true,
      "published"
    );
    const holidays = overview(
      "Holidays",
      "2026-10-20T08:00:00.000Z",
      false,
      "draft"
    );
    const old = overview(
      "Old desk",
      "2026-09-01T08:00:00.000Z",
      true,
      "archived"
    );
    await shown([invoices, old, holidays]);

    expect({ cards: cards(), newApp: newApp() }).toStrictEqual({
      cards: [
        { name: "Holidays", href: `/apps/${holidays.app.id}`, status: "Draft" },
        {
          name: "Invoices",
          href: `/apps/${invoices.app.id}`,
          status: "Published",
        },
        { name: "Old desk", href: `/apps/${old.app.id}`, status: "Archived" },
      ],
      newApp: "/apps/new",
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

  it("offers New App to who builds alone, also before there is any App, and tells someone who doesn't build where Apps shared with them show", async () => {
    await shown([], true);
    const builder = {
      newApp: newApp(),
      said: document.body.textContent.includes("No Apps yet"),
    };
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await shown([], false);

    const user = {
      newApp: newApp(),
      said: document.body.textContent.includes(
        "The Apps your colleagues share with you show here."
      ),
    };

    expect({ builder, user }).toStrictEqual({
      builder: { newApp: "/apps/new", said: true },
      user: { newApp: undefined, said: true },
    });
  });
});
