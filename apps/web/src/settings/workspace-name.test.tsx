// @vitest-environment happy-dom
import type { Organization } from "@grasp-os/shared/organization";
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

import { OrgCard } from "./org-card.tsx";

// Settings › Workspace's card, its name against core's organization as the page
// reaches it over RPC, faked: it keeps a new name, or refuses it, and the
// page's next read answers with what it keeps: the card's name, its heading.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** Core's organization, named `first`; refusing every rename when `refuses`. */
const fakeOrganization = (first: string, refuses = false) => {
  let current: Organization = {
    name: first,
    timeZone: "UTC",
    dataRegion: "eu",
    signInDomains: [],
    logo: null,
  };
  const asked: string[] = [];
  const organization = {
    get: async (): Promise<Organization> => {
      await Promise.resolve();
      return current;
    },
    update: async ({ name }: { name?: string }): Promise<Organization> => {
      await Promise.resolve();
      asked.push(name ?? "");
      if (refuses) {
        throw new Error("Your role doesn't allow that.");
      }
      current = { ...current, name: name ?? current.name };
      return current;
    },
  };
  return { organization, asked };
};

let root: Root | undefined;

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

/** The card, its name as the page last read it: what core keeps. */
const Page = () => {
  // The name as the page last read it: what core keeps.
  const name = useRouterState({
    select: (state) => {
      const data: unknown = state.matches[0]?.loaderData;
      return typeof data === "object" && data !== null && "name" in data
        ? String(data.name)
        : "";
    },
  });
  return (
    <OrgCard
      canChange
      organization={{
        name,
        timeZone: "UTC",
        dataRegion: "eu",
        signInDomains: [],
        logo: null,
      }}
    />
  );
};

/** The card, on what `organization` holds. */
const shown = async (
  organization: ReturnType<typeof fakeOrganization>["organization"]
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      action: (session: { organization: typeof organization }) => Promise<T>
    ): Promise<T> => await action({ organization }),
  };
  const rootRoute = createRootRoute({
    loader: async () => await organization.get(),
  });
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
};

/** Presses Edit, types `name` into the dialog's field and presses Save, as a person renames it. */
const rename = async (name: string): Promise<void> => {
  await act(async () => {
    document
      .querySelector<HTMLButtonElement>('button[aria-label="Edit the name"]')
      ?.click();
    await Promise.resolve();
  });
  await settled();
  const field = document.querySelector<HTMLInputElement>(
    '[role="dialog"] input'
  );
  if (field === null) {
    throw new TypeError("No name field");
  }
  await act(async () => {
    Reflect.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(field, name);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  const save = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  ].find((button) => button.textContent.includes("Save"));
  if (save === undefined) {
    throw new TypeError("No Save button");
  }
  await act(async () => {
    save.click();
    await Promise.resolve();
  });
  await settled();
};

/** The name the card shows, as its heading. */
const shownName = (): string =>
  document.querySelector('section[aria-label="Organization"] h2')
    ?.textContent ?? "";

describe("Settings › Workspace › Name", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("renames the organization, and the card shows the new name once core keeps it", async () => {
    const { organization, asked } = fakeOrganization("Noordkade Finance");
    await shown(organization);
    const before = shownName();

    await rename("  Noordkade Finance BV ");

    expect({ before, asked, after: shownName() }).toStrictEqual({
      before: "Noordkade Finance",
      asked: ["Noordkade Finance BV"],
      after: "Noordkade Finance BV",
    });
  });

  it("keeps the old name when core refuses the rename, and says why in the dialog", async () => {
    const { organization } = fakeOrganization("Noordkade Finance", true);
    await shown(organization);

    await rename("Somebody else");

    expect({
      name: shownName(),
      said: document.body.textContent.includes("Your role doesn't allow that."),
    }).toStrictEqual({ name: "Noordkade Finance", said: true });
  });
});
