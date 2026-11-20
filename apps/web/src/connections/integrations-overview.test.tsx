// @vitest-environment happy-dom
import type {
  ListedConnection,
  OfferedCatalog,
} from "@grasp-os/shared/connect";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ItemGrid } from "../grasp/item/index.ts";
import { IntegrationTile } from "./integration-tile.tsx";
import { IntegrationsHeader } from "./integrations-header.tsx";
import { integrationsOf } from "./integrations.ts";
import type { Integration } from "./integrations.ts";

// The Integrations overview as people meet it: the header card says how
// many apps Grasp reaches and names the one that needs someone to sign in
// again, with its fix; every app is the library's tile, saying where it
// stands, that opens it over the page.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Entry = OfferedCatalog["entries"][number];

const entry = (
  id: string,
  name: string,
  source: Entry["source"] = "native"
): Entry => ({
  source,
  id,
  name,
  categories: ["chat"],
  toolCount: 3,
  logo: null,
  description: `${name}, in a sentence.`,
  group: "Chat",
  auth: "managed",
  offered: true,
});

const connection = (
  provider: string,
  change: Partial<ListedConnection> = {}
): ListedConnection => ({
  id: `c-${provider}`,
  source: "native",
  provider,
  scope: "shared",
  status: "active",
  ownerUserId: null,
  connectedBy: "u1",
  connectedByName: "Sanne",
  accountName: null,
  createdAt: "2026-10-01T08:00:00.000Z",
  ...change,
});

let root: Root | undefined;

/** The overview's header and tiles at `/integrations`, and the router, to read where a press went. */
const admin = { role: "admin", staff: false, userId: "u1" } as const;
const member = { role: "user", staff: false, userId: "u2" } as const;

/** The tiles, each opening its app over the page as the overview does (`?app=`). */
const Tiles = ({
  integrations,
  identity,
}: {
  integrations: readonly Integration[];
  identity: { role: "admin" | "user"; staff: boolean; userId: string };
}) => {
  const navigate = useNavigate({ from: "/integrations/" });
  return (
    <ItemGrid aria-label="Apps">
      {integrations.map((integration) => (
        <IntegrationTile
          identity={identity}
          integration={integration}
          key={integration.key}
          onOpen={(key) => {
            void navigate({ search: { app: key } });
          }}
          open={false}
        />
      ))}
    </ItemGrid>
  );
};

const opened = async (
  connections: ListedConnection[],
  identity: { role: "admin" | "user"; staff: boolean; userId: string } = admin
) => {
  const integrations = integrationsOf(
    [
      entry("microsoft", "Microsoft 365"),
      entry("google", "Google Workspace"),
      entry("acme-crm", "Acme CRM", "composio"),
    ],
    connections
  );
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/",
    component: () => (
      <>
        <IntegrationsHeader identity={identity} integrations={integrations} />
        <Tiles identity={identity} integrations={integrations} />
      </>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/integrations/"] }),
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
  return { host, router };
};

/** What a reader hears of `element`: its text, leaving out what is hidden from them (an app's mark). */
const heard = (element: HTMLElement): string => {
  const copy = element.cloneNode(true);
  if (!(copy instanceof HTMLElement)) {
    return "";
  }
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) {
    hidden.remove();
  }
  return copy.textContent ?? "";
};

/** Where pressing `control` (a link, or a tile's button) sent the page: the app it opened. */
const appAfter = async (
  router: Awaited<ReturnType<typeof opened>>["router"],
  control: HTMLElement | null | undefined
): Promise<string | null> => {
  await act(async () => {
    control?.click();
    await Promise.resolve();
  });
  return new URLSearchParams(router.state.location.searchStr).get("app");
};

describe("the Integrations overview", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("says how many apps Grasp reaches and opens the one to sign in to again", async () => {
    const { host, router } = await opened([
      connection("microsoft", { scope: "personal", ownerUserId: "u1" }),
      connection("google", { status: "needs_reauth" }),
    ]);
    expect(host.querySelector("h2")?.textContent).toBe("Grasp reaches 2 apps");
    expect(host.textContent).toContain(
      "Google Workspace needs someone to sign in again."
    );
    const fix = [...host.querySelectorAll("a")].find(
      (link) => link.textContent === "Sign in again"
    );
    await expect(appAfter(router, fix)).resolves.toBe("native:google");
  });

  it("has an admin connect a toolkit again from its panel, as it can't be signed in to again", async () => {
    const { host, router } = await opened([
      connection("acme-crm", { source: "composio", status: "needs_reauth" }),
    ]);
    expect(host.textContent).toContain(
      "Acme CRM stopped working. Connect it again"
    );
    const open = [...host.querySelectorAll("a")].find(
      (link) => link.textContent === "Open Acme CRM"
    );
    await expect(appAfter(router, open)).resolves.toBe("composio:acme-crm");
  });

  it("tells someone who can't sign in again who can, with nothing to press", async () => {
    const { host } = await opened(
      [connection("google", { status: "needs_reauth" })],
      member
    );
    const tile = [
      ...host.querySelectorAll<HTMLElement>('ul[aria-label="Apps"] li'),
    ].find((each) => heard(each).startsWith("Google Workspace"));
    expect(tile === undefined ? "" : heard(tile)).toBe(
      "Google WorkspaceWaiting for an admin"
    );
    expect(host.textContent).toContain(
      "An admin needs to connect Google Workspace again."
    );
    const fixes = [...host.querySelectorAll("a")].filter(
      (link) => link.textContent === "Sign in again"
    );
    expect(fixes).toHaveLength(0);
  });

  it("asks for a first app while nothing is connected, with nothing to fix", async () => {
    const { host } = await opened([]);
    expect(host.querySelector("h2")?.textContent).toBe(
      "Connect the apps your work runs on"
    );
    const fixes = [...host.querySelectorAll("a")].filter(
      (link) => link.textContent === "Sign in again"
    );
    expect(fixes).toHaveLength(0);
  });

  it("opens an app over the page from its tile, saying where a connected one stands", async () => {
    const { host, router } = await opened([
      connection("google", { status: "needs_reauth" }),
    ]);
    const tiles = [
      ...host.querySelectorAll<HTMLElement>('ul[aria-label="Apps"] li'),
    ];
    expect(tiles.map((tile) => heard(tile))).toStrictEqual([
      "Microsoft 3653 tools",
      "Google WorkspaceSign in again",
      "Acme CRM3 tools",
    ]);
    await expect(
      appAfter(router, tiles[2]?.querySelector("button"))
    ).resolves.toBe("composio:acme-crm");
  });
});
