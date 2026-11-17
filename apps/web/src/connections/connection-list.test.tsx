// @vitest-environment happy-dom
import type { Identity } from "@grasp-os/shared/rpc";
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

import { ConnectionList } from "./connection-list.tsx";
import type { CatalogConnection, Integration } from "./integrations.ts";

// The disconnect dialog of a person's connection: it says what the Brain
// kept from it is erased whenever core says the connection may hold some
// (`keepsReads`), and says nothing of the Brain for one that never can.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const person: Identity = {
  userId: "u1",
  email: "ada@example.com",
  name: "Ada",
  role: "user",
  teams: [],
  staff: false,
  expiresAt: "2026-12-31T00:00:00.000Z",
};

const connection = (change: Partial<CatalogConnection>): CatalogConnection => ({
  id: "c1",
  source: "composio",
  provider: "notes",
  scope: "personal",
  status: "active",
  ownerUserId: "u1",
  connectedBy: "u1",
  connectedByName: "Ada",
  accountName: null,
  createdAt: "2026-10-22T08:00:00.000Z",
  ...change,
});

const integrationOf = (connections: CatalogConnection[]): Integration => ({
  key: "composio:notes",
  source: "composio",
  id: "notes",
  name: "Notes",
  categories: [],
  group: "Other",
  description: null,
  auth: undefined,
  logo: null,
  toolCount: undefined,
  offered: true,
  listed: true,
  connections,
});

let root: Root | undefined;

/** The text of the disconnect dialog of the one connection `shown`. */
const disconnectDialog = async (shown: CatalogConnection): Promise<string> => {
  const core = {
    withSession: async <T,>(action: (session: unknown) => Promise<T>) =>
      await action({}),
  };
  const rootRoute = createRootRoute({
    component: () => (
      <ConnectionList
        held={undefined}
        identity={person}
        integration={integrationOf([shown])}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
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
  const trigger = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Disconnect"
  );
  await act(async () => {
    trigger?.click();
    await Promise.resolve();
  });
  return document.querySelector('[role="dialog"]')?.textContent ?? "";
};

const erased = "Everything the Brain kept from it is erased for good.";

describe("disconnecting a connection", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("says what the Brain kept from it is erased when it may hold some, and nothing of the Brain when it can't", async () => {
    const mayHold = await disconnectDialog(connection({ keepsReads: true }));
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    const never = await disconnectDialog(connection({}));

    expect({
      mayHold: mayHold.includes(erased),
      never: never.includes(erased),
      opened: never.includes("Disconnect Notes?"),
    }).toStrictEqual({ mayHold: true, never: false, opened: true });
  });
});
