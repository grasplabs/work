// @vitest-environment happy-dom
import type { ViewedApp } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
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

import { AppAccessRequests } from "./app-access-requests.tsx";

// Asking for access for a domain's App on its Integrations tab, against
// core's permissions, connections and collections as the page reaches them
// over RPC (the boundary from the web app), faked: it keeps the App's
// requests, each waiting for an admin, and refuses one as core does when
// asked to (a personal collection the App can't hold).

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const appId = appIdSchema.parse("app-1");

const crm: ViewedApp = {
  id: appId,
  name: "Pipeline",
  description: "",
  owner: "user-owner",
  responsible: "user-owner",
  audience: null,
  blueprint: null,
  currentVersion: 1,
  pendingVersion: null,
  status: "published",
  process: null,
  createdAt: "2026-10-01T09:00:00.000Z",
  role: "builder",
};

const hubspot = {
  id: "connection-1",
  source: "composio",
  provider: "hubspot",
  scope: "shared",
  status: "active",
  ownerUserId: null,
  connectedBy: "user-admin",
  connectedByName: "Ada",
  accountName: "sales@acme.test",
  createdAt: "2026-10-01T09:00:00.000Z",
  tools: ["HUBSPOT_LIST_DEALS", "HUBSPOT_CREATE_DEAL", "HUBSPOT_DELETE_DEAL"],
  // Grasp classed only these two: the third is never offered.
  offeredTools: ["HUBSPOT_LIST_DEALS", "HUBSPOT_CREATE_DEAL"],
};

const handbook = {
  id: "collection-1",
  name: "Sales handbook",
  description: "",
  owner: "user-admin",
  access: "everyone",
  teams: [],
  sensitive: false,
  source: "here",
  createdAt: "2026-10-01T09:00:00.000Z",
  writable: false,
};

/** Core for one App, its requests, and each request asked. */
const fakeCore = ({ refusing }: { refusing?: string } = {}) => {
  const asked: PermissionRequest[] = [];
  const requested: unknown[] = [];
  const session = {
    permissions: {
      list: async (subject: unknown, status: unknown) => {
        await Promise.resolve();
        expect({ subject, status }).toStrictEqual({
          subject: { type: "app", appId: "app-1" },
          status: "requested",
        });
        return requested;
      },
      request: async (request: PermissionRequest) => {
        await Promise.resolve();
        asked.push(request);
        if (refusing !== undefined) {
          throw new Error(refusing);
        }
        const permission = {
          id: `permission-${requested.length + 1}`,
          ...request,
          status: "requested",
          requestedBy: "user-owner",
          requestedAt: "2026-10-30T09:00:00.000Z",
        };
        requested.push(permission);
        return permission;
      },
    },
    connections: {
      list: async () => {
        await Promise.resolve();
        return [hubspot];
      },
      catalog: async () => {
        await Promise.resolve();
        return { entries: [] };
      },
      catalogTools: async (source: string, id: string) => {
        await Promise.resolve();
        expect([source, id]).toStrictEqual(["composio", "hubspot"]);
        return hubspot.tools.map((name) => ({
          name,
          description: null,
          inputs: [],
        }));
      },
    },
    knowledge: {
      listCollections: async () => {
        await Promise.resolve();
        return [handbook];
      },
    },
  };
  return { session, asked };
};

let root: Root | undefined;

const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

const shown = async (
  session: ReturnType<typeof fakeCore>["session"],
  { app = crm, staff = false } = {}
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      run: (reached: typeof session) => Promise<T>
    ): Promise<T> => await run(session),
  };
  const rootRoute = createRootRoute({
    component: () => <AppAccessRequests app={app} identity={{ staff }} />,
  });
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

const unmount = (): void => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.innerHTML = "";
};

const press = async (element: Element | undefined) => {
  if (!(element instanceof HTMLElement)) {
    throw new TypeError("Nothing to press");
  }
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

const button = (name: string) =>
  [...document.querySelectorAll("button")].findLast(
    (each) => each.textContent?.trim() === name
  );

/** The control of the field labelled `label`. */
const field = (label: string) => {
  const named = [...document.querySelectorAll("label")].find(
    (each) => each.textContent?.trim() === label
  );
  return [...document.querySelectorAll("input, button")].find(
    (each) => each.id !== "" && each.id === named?.htmlFor
  );
};

/** Chooses `option` in the select labelled `label`. */
const choose = async (label: string, option: string): Promise<void> => {
  await press(field(label));
  await press(
    [...document.querySelectorAll('[role="option"]')].find(
      (each) => each.textContent?.trim() === option
    )
  );
};

/** Ticks the tool `name`. */
const tick = async (name: string): Promise<void> => {
  const label = [...document.querySelectorAll("label")].find((each) =>
    each.textContent?.startsWith(name)
  );
  await press(label?.querySelector('input[type="checkbox"]') ?? undefined);
};

/** The tools offered to tick. */
const offered = (): string[] =>
  [...document.querySelectorAll("fieldset label .font-mono")].map(
    (each) => each.textContent ?? ""
  );

/** Each request listed: what, which actions, under which name. */
const listed = (): string[][] =>
  [...document.querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("td")]
      .slice(0, 3)
      .map((cell) => cell.textContent?.trim() ?? "")
  );

const bindingOf = (): string | undefined => {
  const box = field("Name in the app's code");
  return box instanceof HTMLInputElement ? box.value : undefined;
};

describe("Asking for access for a domain's app, for its builders", () => {
  afterEach(() => {
    unmount();
  });

  it("asks for the connection's offered tools it ticks, under a name, and lists the request as waiting", async () => {
    const { session, asked } = fakeCore();
    await shown(session);
    const before = listed();

    await press(button("Ask for access"));
    await choose("Connection", "hubspot · sales@acme.test");
    const tools = offered();
    const suggested = bindingOf();
    await tick("HUBSPOT_LIST_DEALS");
    await press(button("Ask an admin"));

    expect({ before, tools, suggested, asked, listed: listed() }).toStrictEqual(
      {
        before: [],
        tools: ["HUBSPOT_LIST_DEALS", "HUBSPOT_CREATE_DEAL"],
        suggested: "HUBSPOT_SALES_ACME_TEST",
        asked: [
          {
            subject: { type: "app", appId: "app-1" },
            object: { type: "connection", connectionId: "connection-1" },
            actions: ["HUBSPOT_LIST_DEALS"],
            binding: "HUBSPOT_SALES_ACME_TEST",
          },
        ],
        listed: [
          [
            "hubspot · sales@acme.test",
            "HUBSPOT_LIST_DEALS",
            "HUBSPOT_SALES_ACME_TEST",
          ],
        ],
      }
    );
  });

  it("asks to read a collection", async () => {
    const { session, asked } = fakeCore();
    await shown(session);

    await press(button("Ask for access"));
    await choose("What it needs", "A collection to read");
    await choose("Collection", "Sales handbook");
    await press(button("Ask an admin"));

    expect(asked).toStrictEqual([
      {
        subject: { type: "app", appId: "app-1" },
        object: { type: "collection", collectionId: "collection-1" },
        actions: ["read"],
        binding: "SALES_HANDBOOK",
      },
    ]);
  });

  it("says why core refused, and keeps the request to change", async () => {
    const { session } = fakeCore({
      refusing: "A personal collection can't be given to an App or agent.",
    });
    await shown(session);

    await press(button("Ask for access"));
    await choose("What it needs", "A collection to read");
    await choose("Collection", "Sales handbook");
    await press(button("Ask an admin"));

    expect({
      told: document.body.textContent?.includes(
        "A personal collection can't be given to an App or agent."
      ),
      open: button("Ask an admin") !== undefined,
    }).toStrictEqual({ told: true, open: true });
  });

  it("is not offered on an archived domain, and shows nothing to who doesn't build it", async () => {
    const archived = fakeCore();
    await shown(archived.session, { app: { ...crm, status: "archived" } });
    const archivedAsks = button("Ask for access") !== undefined;
    unmount();
    await shown(fakeCore().session, { app: { ...crm, role: "user" } });
    const user = document.body.textContent;
    unmount();
    await shown(fakeCore().session, { staff: true });

    expect({
      archivedAsks,
      user,
      staff: document.body.textContent,
    }).toStrictEqual({ archivedAsks: false, user: "", staff: "" });
  });
});
