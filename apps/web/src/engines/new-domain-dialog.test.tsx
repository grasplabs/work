// @vitest-environment happy-dom
import type { App, NewApp } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import { roleErrors } from "@grasp-os/shared/roles";
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

import { NewDomainDialog } from "./new-domain-dialog.tsx";

// New domain against core's Apps as the page reaches them over RPC (the
// boundary from the web app), faked: Make domain asks core for a new App
// with the name and what it runs, and hands back the one core made; a
// refusal says why and makes nothing.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const made = (input: NewApp): App => ({
  id: appIdSchema.parse("app-1"),
  name: input.name,
  description: input.description ?? "",
  owner: "user-1",
  responsible: "user-1",
  audience: null,
  blueprint: null,
  currentVersion: null,
  pendingVersion: null,
  status: "draft",
  link: null,
  process: null,
  createdAt: "2026-10-30T08:00:00.000Z",
});

let root: Root | undefined;

/** The dialog, open, against `create`; resolves to the domains it handed back. */
const opened = async (create: (input: NewApp) => Promise<App>) => {
  const handed: string[] = [];
  const core = {
    withSession: async <T,>(
      action: (session: { apps: { create: typeof create } }) => Promise<T>
    ): Promise<T> => await action({ apps: { create } }),
  };
  const rootRoute = createRootRoute({
    component: () => (
      <NewDomainDialog
        onMade={(domain) => {
          handed.push(domain);
        }}
        onOpenChange={() => {
          // Stays open: what it shows after Make domain is what is tested.
        }}
        open
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/domains"] }),
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
  return handed;
};

/** Types `value` into the field labelled `label`, as React hears a person type. */
const typeInto = async (label: string, value: string): Promise<void> => {
  const field = [
    ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      "input, textarea"
    ),
  ].find((each) => each.labels?.[0]?.textContent === label);
  if (field === undefined) {
    throw new TypeError(`No field ${label}`);
  }
  await act(async () => {
    const prototype = Reflect.getPrototypeOf(field) ?? {};
    Reflect.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      field,
      value
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

const makeDomain = async (): Promise<void> => {
  await act(async () => {
    document.querySelector("form")?.requestSubmit();
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

describe("making a domain", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("makes it in core with its name and what it runs, and hands back the new domain", async () => {
    const asked: NewApp[] = [];
    const handed = await opened(async (input) => {
      asked.push(input);
      await Promise.resolve();
      return made(input);
    });

    await typeInto("Name", "  Leasing ");
    await typeInto("What does it run?", "Lease contracts, from request on.");
    await makeDomain();

    expect({ asked, handed }).toStrictEqual({
      asked: [
        { name: "Leasing", description: "Lease contracts, from request on." },
      ],
      handed: ["app-1"],
    });
  });

  it("says why core refused it, and hands back nothing", async () => {
    const handed = await opened(async () => {
      await Promise.resolve();
      throw roleErrors.create("role.forbidden");
    });

    await typeInto("Name", "Leasing");
    await makeDomain();

    expect({
      handed,
      said: document.querySelector('[role="alert"]')?.textContent,
    }).toStrictEqual({ handed: [], said: "Your role doesn't allow that." });
  });

  it("can't be made without a name", async () => {
    const asked: NewApp[] = [];
    await opened(async (input) => {
      asked.push(input);
      await Promise.resolve();
      return made(input);
    });

    await typeInto("Name", "   ");
    await makeDomain();

    expect(asked).toStrictEqual([]);
  });
});
