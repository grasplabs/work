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

import { useShownName } from "../frame/organization-name.tsx";
import { NameField } from "./workspace-name.tsx";

// Settings › Workspace › Name against core's organization as the page
// reaches it over RPC, faked: it keeps a new name, or refuses it, and the
// page's next read answers with what it keeps. Beside the field, the
// sidebar's line as frame/organization-name.tsx shows it.

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

/** The sidebar's line: the name it shows, read once from core. */
const Sidebar = ({ read }: { read: () => Promise<Organization> }) => (
  <p data-testid="sidebar">{useShownName(read)}</p>
);

/** The name field, and the sidebar beside it, on what `organization` holds. */
const shown = async (
  organization: ReturnType<typeof fakeOrganization>["organization"]
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      action: (session: { organization: typeof organization }) => Promise<T>
    ): Promise<T> => await action({ organization }),
  };
  const read = organization.get;
  const rootRoute = createRootRoute({
    loader: async () => await organization.get(),
  });
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
      <>
        <Sidebar read={read} />
        <NameField canChange name={name} />
      </>
    );
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
};

/** Types `name` into the field and presses Enter, as a person renames it. */
const rename = async (name: string): Promise<void> => {
  const field = document.querySelector("input");
  if (field === null) {
    throw new TypeError("No name field");
  }
  await act(async () => {
    field.focus();
    Reflect.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(field, name);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await act(async () => {
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    );
    field.blur();
    await Promise.resolve();
  });
  await settled();
};

const sidebar = (): string =>
  document.querySelector('[data-testid="sidebar"]')?.textContent ?? "";

describe("Settings › Workspace › Name", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("renames the organization, and the sidebar shows the new name at once", async () => {
    const { organization, asked } = fakeOrganization("Noordkade Finance");
    await shown(organization);
    const before = sidebar();

    await rename("  Noordkade Finance BV ");

    expect({ before, asked, after: sidebar() }).toStrictEqual({
      before: "Noordkade Finance",
      asked: ["Noordkade Finance BV"],
      after: "Noordkade Finance BV",
    });
  });

  it("keeps the old name in the sidebar when core refuses the rename, and says why at the field", async () => {
    const { organization } = fakeOrganization("Noordkade Finance", true);
    await shown(organization);

    await rename("Somebody else");

    expect({
      sidebar: sidebar(),
      said: document.body.textContent.includes("Your role doesn't allow that."),
    }).toStrictEqual({ sidebar: "Noordkade Finance", said: true });
  });
});
