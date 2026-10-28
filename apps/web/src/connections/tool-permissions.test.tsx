// @vitest-environment happy-dom
import type {
  CatalogTool,
  ComposioToolRule,
  ListedConnection,
} from "@grasp-os/shared/connect";
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

import { ToolPermissions } from "./tool-permissions.tsx";

// An app's page letting an admin change what Grasp may do in it (GRA-993),
// against core's connections as the page reaches them over RPC, faked:
// each switch and badge sends the whole new choice of tools, the last tool
// allowed can't be switched off, and Grasp's staff change nothing.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const tools: CatalogTool[] = [
  {
    name: "HUBSPOT_LIST_CONTACTS",
    description: null,
    inputs: [],
    readOnly: true,
  },
  {
    name: "HUBSPOT_CREATE_NOTE",
    description: null,
    inputs: [],
    readOnly: false,
  },
  {
    name: "HUBSPOT_DELETE_NOTE",
    description: null,
    inputs: [],
    readOnly: false,
  },
];

const connection: ListedConnection = {
  id: "connection-1",
  source: "composio",
  provider: "hubspot",
  scope: "shared",
  status: "active",
  ownerUserId: null,
  connectedBy: "u1",
  connectedByName: "Ada",
  accountName: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  tools: ["HUBSPOT_LIST_CONTACTS", "HUBSPOT_CREATE_NOTE"],
  offeredTools: ["HUBSPOT_LIST_CONTACTS", "HUBSPOT_CREATE_NOTE"],
  readTools: ["HUBSPOT_LIST_CONTACTS"],
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

/** The switches for `shown`, recording each change of tools sent to core. */
const shown = async (
  listed: ListedConnection,
  staff = false
): Promise<
  { connectionId: string; tools: (string | ComposioToolRule)[] }[]
> => {
  const sent: { connectionId: string; tools: (string | ComposioToolRule)[] }[] =
    [];
  const connections = {
    changeTools: async (request: {
      connectionId: string;
      tools: (string | ComposioToolRule)[];
    }): Promise<{ tools: string[] }> => {
      sent.push(request);
      return await Promise.resolve({ tools: [] });
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { connections: typeof connections }) => Promise<T>
    ): Promise<T> => await action({ connections }),
  };
  const rootRoute = createRootRoute({
    component: () => (
      <ToolPermissions connection={listed} staff={staff} tools={tools} />
    ),
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
  return sent;
};

/** The row of the tool named `name`. */
const row = (name: string): HTMLElement => {
  const found = [...document.querySelectorAll("li")].find((each) =>
    each.textContent?.includes(name)
  );
  if (found === undefined) {
    throw new Error(`No row for ${name}`);
  }
  return found;
};

const press = async (element: Element | null | undefined): Promise<void> => {
  if (!(element instanceof HTMLElement)) {
    throw new TypeError("Nothing to press");
  }
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

const switchOf = (name: string) => row(name).querySelector('[role="switch"]');
const badgeOf = (name: string) => row(name).querySelector("button");

describe("changing what Grasp may do in a connected app", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("shows each tool as the connection allows it, and sends the whole new choice on each switch or badge", async () => {
    const sent = await shown(connection);
    const labels = tools.map(({ name }) => row(name).textContent ?? "");
    await press(switchOf("HUBSPOT_DELETE_NOTE"));
    await press(badgeOf("HUBSPOT_LIST_CONTACTS"));

    expect({
      labels: labels.map((text) =>
        ["Read", "Write", "Never"].find((badge) => text.includes(badge))
      ),
      sent,
    }).toStrictEqual({
      labels: ["Read", "Write", "Never"],
      sent: [
        {
          connectionId: "connection-1",
          // Newly allowed, as Composio's hint says: it changes things.
          tools: [
            { name: "HUBSPOT_LIST_CONTACTS", read: true },
            "HUBSPOT_CREATE_NOTE",
            "HUBSPOT_DELETE_NOTE",
          ],
        },
        {
          connectionId: "connection-1",
          tools: ["HUBSPOT_LIST_CONTACTS", "HUBSPOT_CREATE_NOTE"],
        },
      ],
    });
  });

  it("keeps each tool's resource rule through a change of any switch or badge", async () => {
    const scoped = {
      ...connection,
      toolResources: {
        HUBSPOT_LIST_CONTACTS: "pipeline",
        HUBSPOT_CREATE_NOTE: "pipeline",
      },
    };
    const sent = await shown(scoped);
    await press(switchOf("HUBSPOT_DELETE_NOTE"));
    await press(badgeOf("HUBSPOT_LIST_CONTACTS"));

    expect(sent.map(({ tools: chosen }) => chosen)).toStrictEqual([
      [
        { name: "HUBSPOT_LIST_CONTACTS", read: true, resource: "pipeline" },
        { name: "HUBSPOT_CREATE_NOTE", resource: "pipeline" },
        "HUBSPOT_DELETE_NOTE",
      ],
      [
        { name: "HUBSPOT_LIST_CONTACTS", resource: "pipeline" },
        { name: "HUBSPOT_CREATE_NOTE", resource: "pipeline" },
      ],
    ]);
  });

  it("keeps the last tool allowed switched on, and lets Grasp's staff change nothing", async () => {
    const one = { ...connection, tools: ["HUBSPOT_LIST_CONTACTS"] };
    const sent = await shown(one);
    const lastLocked = switchOf("HUBSPOT_LIST_CONTACTS")?.getAttribute(
      "aria-disabled"
    );
    act(() => {
      root?.unmount();
    });
    document.body.innerHTML = "";
    await shown(connection, true);
    const staffLocked = tools.map(
      ({ name }) => switchOf(name)?.getAttribute("aria-disabled") ?? null
    );

    expect({ sent, lastLocked, staffLocked }).toStrictEqual({
      sent: [],
      lastLocked: "true",
      staffLocked: ["true", "true", "true"],
    });
  });
});
