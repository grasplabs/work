import type {
  ConnectorToolView,
  ListedConnection,
  OfferedCatalog,
} from "@grasp-os/shared/connect";
import type { Identity } from "@grasp-os/shared/rpc";
// @vitest-environment happy-dom
import { SidebarProvider } from "@grasp-os/ui/components/sidebar";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

import { Route } from "../routes/_shell.connectors.$integration.tsx";
import { Route as ListRoute } from "../routes/_shell.connectors.index.tsx";

// The Integrations pages as the browser comes back to them from a
// sign-in, through their routes, against core faked: they never disconnect
// anything by themselves. Back with the new connection beside a stopped one, back from a
// sign-in refused or cancelled, or opened from a crafted link, nothing is
// disconnected; the success page says "again" where a stopped connection
// stands beside the new one, read from what the page lists; and the
// stopped row says it can be disconnected now, to an admin alone, whose
// press opens the Disconnect question, which says what goes with it. A
// connector made from a URL says where its sign-in page is, and shows its
// admin its tools, each to block by its switch.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// Someone who asked for less motion: nothing waits on animations the test
// DOM can't run.
Reflect.set(window, "matchMedia", (query: string) => ({
  matches: query.includes("reduce"),
  media: query,
  onchange: null,
  addEventListener: () => {
    // Nothing changes during a test.
  },
  removeEventListener: () => {
    // Nothing to stop.
  },
  dispatchEvent: () => false,
}));

const entry: OfferedCatalog["entries"][number] = {
  source: "composio",
  id: "hubspot",
  name: "HubSpot",
  categories: ["CRM"],
  toolCount: 1,
  logo: null,
  description: "A CRM.",
  group: "Other",
  auth: "managed",
  offered: true,
};

/** Microsoft 365, Grasp's own connector: an admin signs in again to its shared mailboxes. */
const microsoft: OfferedCatalog["entries"][number] = {
  source: "native",
  id: "microsoft",
  name: "Microsoft 365",
  categories: ["Productivity"],
  toolCount: 0,
  logo: null,
  description: null,
  group: "Other",
  auth: "managed",
  offered: true,
};

/** A connector made from a URL whose server signs people in at its own host. */
const linear: OfferedCatalog["entries"][number] = {
  source: "connector",
  id: "mcp_0123456789abcdef0123456789abcdef",
  name: "Linear",
  categories: [],
  toolCount: null,
  logo: null,
  description: null,
  group: "Other",
  auth: "managed",
  offered: true,
  signInHost: "mcp.linear.app",
};

/** What core was asked of a connector's tools: each block, and how often they were read. */
const toolAsks: {
  blocks: { connector: string; tool: string; blocked: boolean }[];
  reads: number;
} = { blocks: [], reads: 0 };

/** Linear's tools as connect lists them, blocked as last asked: one no list holds now, blocked already. */
const linearTools = (): ConnectorToolView[] => {
  const blocked = (tool: string, before: boolean): boolean =>
    toolAsks.blocks.findLast((block) => block.tool === tool)?.blocked ?? before;
  return [
    {
      name: "create_issue",
      description: "Creates an issue in a team.",
      class: "change-company",
      blocked: blocked("create_issue", false),
    },
    {
      name: "list_issues",
      description: "Lists the issues of a team.",
      class: "read-company",
      blocked: blocked("list_issues", false),
    },
    {
      name: "delete_team",
      description: null,
      class: null,
      blocked: blocked("delete_team", true),
    },
  ];
};

/** HubSpot's shared connection that stopped working: a Composio one names no account. */
const stopped: ListedConnection = {
  id: "c-stopped",
  source: "composio",
  provider: "hubspot",
  name: "hubspot",
  scope: "shared",
  status: "needs_reauth",
  ownerUserId: null,
  connectedBy: "u1",
  connectedByName: "Ada",
  accountName: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  tools: ["HUBSPOT_LIST_CONTACTS"],
  readTools: ["HUBSPOT_LIST_CONTACTS"],
};

/** The one the admin just made beside it, which works. */
const made: ListedConnection = {
  ...stopped,
  id: "c-new",
  status: "active",
  createdAt: "2026-11-23T00:00:00.000Z",
};

/** A shared Microsoft mailbox, `account`, as `status` says. */
const mailbox = (
  account: string,
  status: ListedConnection["status"]
): ListedConnection => ({
  id: `c-${account}`,
  source: "native",
  provider: "microsoft",
  name: "Microsoft 365",
  scope: "shared",
  status,
  ownerUserId: null,
  connectedBy: "u1",
  connectedByName: "Ada",
  accountName: account,
  createdAt: "2026-10-01T00:00:00.000Z",
});

const person = (change: Partial<Identity> = {}): Identity => ({
  userId: "u1",
  email: "ada@example.com",
  name: "Ada",
  role: "admin",
  teams: [],
  staff: false,
  expiresAt: "2026-12-31T00:00:00.000Z",
  ...change,
});

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

/** Anything else a page reads: refused, as an older core would. */
const notHere = async (): Promise<never> => {
  await Promise.resolve();
  throw new Error("Not in this test");
};

/**
 * A faked core whose session answers what the pages read, from
 * `connections`, and records every disconnect asked of it.
 */
const coreOf = (
  connections: ListedConnection[],
  disconnected: string[],
  catalog: () => Promise<OfferedCatalog> = async () =>
    await Promise.resolve({
      entries: [entry, microsoft, linear],
      composio: "listed",
    })
) => {
  const known = {
    connections: {
      catalog,
      list: async (): Promise<ListedConnection[]> =>
        await Promise.resolve(connections),
      catalogTools: async () =>
        await Promise.resolve([
          {
            name: "HUBSPOT_LIST_CONTACTS",
            description: null,
            inputs: [],
            readOnly: true,
          },
        ]),
      audiences: async () => await Promise.resolve([]),
      connectorTools: async (): Promise<ConnectorToolView[]> => {
        toolAsks.reads += 1;
        return await Promise.resolve(linearTools());
      },
      blockConnectorTool: async (request: {
        connector: string;
        tool: string;
        blocked: boolean;
      }): Promise<void> => {
        toolAsks.blocks.push(request);
        await Promise.resolve();
      },
      disconnect: async (id: string): Promise<{ revoked: boolean }> => {
        disconnected.push(id);
        return await Promise.resolve({ revoked: true });
      },
    },
    workflows: { byConnection: async () => await Promise.resolve([]) },
    permissions: { list: async () => await Promise.resolve([]) },
    apps: { list: async () => await Promise.resolve([]) },
  };
  // What the test gives, else refused.
  const session = new Proxy(known, {
    get: (target, name) => {
      const part: unknown = Reflect.get(target, name);
      return new Proxy(typeof part === "object" && part !== null ? part : {}, {
        get: (methods, method) => {
          const given: unknown = Reflect.get(methods, method);
          return given ?? notHere;
        },
      });
    },
  });
  return {
    withSession: async <T,>(
      action: (given: typeof session) => Promise<T>
    ): Promise<T> => await action(session),
  };
};

/**
 * The app's page at `address`, as `identity` sees it, with `connections`
 * listed: every disconnect asked of core, so far.
 */
const shown = async (
  address: string,
  connections: ListedConnection[],
  identity: Identity = person(),
  catalog?: () => Promise<OfferedCatalog>
): Promise<string[]> => {
  const disconnected: string[] = [];
  const top = createRootRoute();
  // The shell's part: who is signed in, in the page's context.
  const shell = createRoute({
    getParentRoute: () => top,
    id: "_shell",
    beforeLoad: () => ({ identity }),
  });
  // Each page under the shell, as the generated route tree places it.
  const pageAt = {
    id: "/connectors/$integration",
    path: "/connectors/$integration",
    getParentRoute: () => shell,
  };
  const listAt = {
    id: "/connectors/",
    path: "/connectors/",
    getParentRoute: () => shell,
  };
  // SAFETY: a place in the tree, as routeTree.gen.ts gives each route.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const page = Route.update(pageAt as Parameters<typeof Route.update>[0]);
  const list = ListRoute.update(
    // SAFETY: a place in the tree, as routeTree.gen.ts gives each route.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    listAt as Parameters<typeof ListRoute.update>[0]
  );
  const router = createRouter({
    routeTree: top.addChildren([shell.addChildren([page, list])]),
    history: createMemoryHistory({ initialEntries: [address] }),
    context: { core: coreOf(connections, disconnected, catalog) },
  });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        {/* The frame's, around every page: the page's header opens it. */}
        <SidebarProvider>
          <RouterProvider router={router} />
        </SidebarProvider>
      </I18nProvider>
    );
    await router.load();
  });
  await settled();
  return disconnected;
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

/** The button whose words are `text`. */
const button = (text: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>("button")].find(
    (each) => each.textContent.trim() === text
  );

/** The page's account rows' words. */
const rows = (): string[] =>
  [...document.querySelectorAll('[data-slot="app-account"]')].map(
    (each) => each.textContent
  );

const notice =
  "A connection that works has taken its place, so this one can be disconnected now.";

/** Unmounts what a test drew, for it to draw the page anew. */
const unmounted = (): void => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.innerHTML = "";
  toolAsks.blocks = [];
  toolAsks.reads = 0;
};

/** The section titled `title`, by its heading. */
const section = (title: string): Element | undefined =>
  [...document.querySelectorAll("section h2")]
    .find((heading) => heading.textContent === title)
    ?.closest("section") ?? undefined;

/** The rows of the connector's tools, each its words and whether its switch lets it through. */
const toolRows = (): { words: string; on: string | null }[] =>
  [
    ...(section("Tools its server lists")?.querySelectorAll(
      '[data-slot="item"]'
    ) ?? []),
  ].map((row) => ({
    words: row.textContent,
    on:
      row.querySelector('[role="switch"]')?.getAttribute("aria-checked") ??
      null,
  }));

describe("the Connectors pages, back from a sign-in", () => {
  // The router's plugin splits each page's code from its route: loaded
  // once here, as a browser does the first time it opens a page, and not
  // in any one test's time.
  beforeAll(async () => {
    await shown("/connectors/composio:hubspot", [made]);
    unmounted();
    await shown("/connectors", [made]);
    unmounted();
  }, 60_000);

  afterEach(unmounted);

  it("keeps the accounts that loaded when the catalog didn't, saying beside them why it didn't", async () => {
    await shown(
      "/connectors",
      [mailbox("ada@example.com", "active")],
      person(),
      async () => {
        await Promise.resolve();
        throw Object.assign(new Error("The catalog can't be read."), {
          code: "connection.catalog_unavailable",
        });
      }
    );
    const alerts = [...document.querySelectorAll('[role="alert"]')].map(
      (each) => each.textContent
    );

    expect({
      // The account's tile, under connect's name for it, as the catalog names none.
      app: [...document.querySelectorAll("button")].some((each) =>
        each.textContent.startsWith("Microsoft 365")
      ),
      said: alerts.some((each) => each.includes("The catalog can't be read.")),
      searched: document.body.textContent.includes("No apps match"),
    }).toStrictEqual({ app: true, said: true, searched: false });
  });

  it("disconnects nothing back from a sign-in that made a new connection beside a stopped one, and says it is connected again", async () => {
    const disconnected = await shown(
      "/connectors/composio:hubspot?connection=c-new",
      [made, stopped]
    );
    const page = {
      title: document.querySelector('[role="dialog"] h2')?.textContent,
      stoppedRow: rows()
        .find((each) => each.includes("Stopped working"))
        ?.includes(notice),
    };
    unmounted();
    // Sent back to the list instead: the same.
    const listed = await shown("/connectors?connection=c-new", [made, stopped]);

    expect({
      disconnected,
      page,
      listed,
      listTitle: document.querySelector('[role="dialog"] h2')?.textContent,
    }).toStrictEqual({
      disconnected: [],
      page: {
        title: "HubSpot is connected again",
        stoppedRow: true,
      },
      listed: [],
      listTitle: "HubSpot is connected again",
    });
  });

  it("disconnects nothing back from a sign-in refused or cancelled, and says nothing of a disconnect", async () => {
    // Refused at the provider: core sends the browser back to the list, with its code.
    const refused = await shown(
      "/connectors?connectionError=connection.provider_refused",
      [stopped]
    );
    const refusedSays = document.body.textContent;
    const said = document
      .querySelector('[role="alert"]')
      ?.textContent.includes("The provider didn't complete the connection.");
    unmounted();
    // Cancelled: the browser comes back to the page as it left it.
    const cancelled = await shown("/connectors/composio:hubspot", [stopped]);

    expect({
      refused,
      said,
      cancelled,
      saysDisconnect: [refusedSays, document.body.textContent].some((text) =>
        text.includes("couldn't be disconnected")
      ),
      // No connection works: nothing says the stopped one can go.
      notice: document.body.textContent.includes(notice),
    }).toStrictEqual({
      refused: [],
      said: true,
      cancelled: [],
      saysDisconnect: false,
      notice: false,
    });
  });

  it("shows an admin what core named for support under a refusal, only in its fixed form, and nobody else", async () => {
    const named =
      "/connectors?connectionError=connection.provider_refused&connectionReason=session%3Ahttp_403&connectionRelease=26.11.900&connectionVersion=1a2b3c4d";
    await shown(named, [stopped]);
    const admin = document.querySelector(
      '[role="alert"] [data-release]'
    )?.textContent;
    unmounted();
    // Anyone can put anything in a link: what isn't in its form isn't shown.
    await shown(
      "/connectors?connectionError=connection.provider_refused&connectionReason=see%20evil.example&connectionRelease=call-support.evil.example&connectionVersion=not-hex",
      [stopped]
    );
    const said = document.querySelector('[role="alert"]')?.textContent ?? "";
    const crafted = {
      dashes: said.includes("Details for support: – (release –, connect –)"),
      echoed: ["evil", "call-support", "not-hex"].some((text) =>
        said.includes(text)
      ),
    };
    unmounted();
    await shown(named, [stopped], person({ role: "user" }));
    const user = document.body.textContent.includes("Details for support");

    expect({ admin, crafted, user }).toStrictEqual({
      admin:
        "Details for support: session:http_403 (release 26.11.900, connect 1a2b3c4d)",
      crafted: { dashes: true, echoed: false },
      user: false,
    });
  });

  it("disconnects nothing from a crafted link naming a connection, with or without the old again", async () => {
    const named = await shown(
      "/connectors/composio:hubspot?connection=c-new&again=1",
      [made, stopped]
    );
    unmounted();
    // The stopped one's own ID: no success page for a connection that doesn't work.
    const stoppedId = await shown(
      "/connectors/composio:hubspot?connection=c-stopped",
      [made, stopped]
    );

    expect({
      named,
      stoppedId,
      dialog: document.querySelector('[role="dialog"]'),
    }).toStrictEqual({ named: [], stoppedId: [], dialog: null });
  });

  it("says a stopped row can go only beside a connection that works, and only to whoever may disconnect it", async () => {
    await shown("/connectors/composio:hubspot", [made, stopped]);
    const admin = rows().map((each) => each.includes(notice));
    unmounted();
    await shown("/connectors/composio:hubspot", [stopped]);
    const alone = document.body.textContent.includes(notice);
    unmounted();
    await shown(
      "/connectors/composio:hubspot",
      [made, stopped],
      person({ role: "user" })
    );
    const member = {
      notice: document.body.textContent.includes(notice),
      action: button("Disconnect it"),
    };

    expect({ admin, alone, member }).toStrictEqual({
      // The working row says nothing; the stopped one does.
      admin: [false, true],
      alone: false,
      member: { notice: false, action: undefined },
    });
  });

  it("opens the Disconnect question from the stopped row's notice, which says what goes, and disconnects only once confirmed", async () => {
    const disconnected = await shown("/connectors/composio:hubspot", [
      made,
      stopped,
    ]);
    await press(button("Disconnect it"));
    const question = document.querySelector('[role="alertdialog"]');
    const asked = {
      title: question?.querySelector("h2")?.textContent,
      says: question?.textContent.includes(
        "Its tokens are deleted, every App and agent loses it, and actions waiting on it are dropped."
      ),
      before: [...disconnected],
    };
    await press(
      [...(question?.querySelectorAll("button") ?? [])].findLast((each) =>
        each.textContent.startsWith("Disconnect")
      )
    );

    expect({ asked, disconnected }).toStrictEqual({
      asked: {
        title: "Disconnect HubSpot?",
        says: true,
        before: [],
      },
      disconnected: ["c-stopped"],
    });
  });

  it("says nothing of a stopped mailbox beside another account's that works: it is signed in to again", async () => {
    const out = mailbox("sales@example.com", "needs_reauth");
    const working = mailbox("support@example.com", "active");
    await shown("/connectors/native:microsoft", [working, out]);
    const row = rows().find((each) => each.includes("sales@example.com"));

    expect({
      notice: document.body.textContent.includes(notice),
      disconnectIt: button("Disconnect it"),
      signInAgain: row?.includes("Sign in again"),
    }).toStrictEqual({
      notice: false,
      disconnectIt: undefined,
      signInAgain: true,
    });
  });

  it("shows an admin a connector's tools by what they do, and blocks one by its switch, read again from core", async () => {
    await shown(`/connectors/connector:${linear.id}`, []);
    const before = toolRows();
    await press(
      document.querySelector('[aria-label="Let Grasp use create_issue"]')
    );

    expect({
      before,
      blocks: toolAsks.blocks,
      after: toolRows(),
    }).toStrictEqual({
      before: [
        { words: "create_issueChangesCreates an issue in a team.", on: "true" },
        { words: "list_issuesReadsLists the issues of a team.", on: "true" },
        { words: "delete_teamNot listed now", on: "false" },
      ],
      blocks: [{ connector: linear.id, tool: "create_issue", blocked: true }],
      after: [
        {
          words: "create_issueChangesCreates an issue in a team.",
          on: "false",
        },
        { words: "list_issuesReadsLists the issues of a team.", on: "true" },
        { words: "delete_teamNot listed now", on: "false" },
      ],
    });
  });

  it("shows anyone but an admin none of a connector's tools to block, and never asks core for them", async () => {
    await shown(
      `/connectors/connector:${linear.id}`,
      [],
      person({ role: "user" })
    );

    expect({
      section: section("Tools its server lists"),
      reads: toolAsks.reads,
    }).toStrictEqual({ section: undefined, reads: 0 });
  });

  it("says where a connector made from a URL signs people in, as they connect it", async () => {
    await shown(`/connectors/connector:${linear.id}`, []);
    await press(button("Connect"));

    expect(
      document
        .querySelector('[role="dialog"]')
        ?.textContent.includes("You’ll sign in at mcp.linear.app.")
    ).toBeTruthy();
  });
});
