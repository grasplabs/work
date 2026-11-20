// @vitest-environment happy-dom
import type {
  CatalogTool,
  ComposioToolRule,
  ListedConnection,
  OfferedCatalog,
} from "@grasp-os/shared/connect";
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

import { IntegrationAppPage } from "./app-page.tsx";
import { integrationsOf } from "./integrations.ts";

// An app's own page on the library's app page, letting an admin change
// what Grasp may do in a shared Composio connection (GRA-993), against
// core's connections as the page reaches them over RPC, faked: a group's
// or a tool's choice sends the whole new choice of tools with what the
// page showed, a resource rule goes with it, the last tool allowed can't
// be taken away, a tool no longer offered can still be, and members and
// Grasp's staff read what Grasp may do without changing it. A change ends
// with the page read again at the address it then has.

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

const entry: OfferedCatalog["entries"][number] = {
  source: "composio",
  id: "hubspot",
  name: "HubSpot",
  categories: ["CRM"],
  toolCount: tools.length,
  logo: null,
  description: "A CRM.",
  group: "Other",
  auth: "managed",
  offered: true,
};

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
let history: ReturnType<typeof createMemoryHistory> | undefined;

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

/** A change of tools as the page sends it to core. */
interface Sent {
  connectionId: string;
  tools: (string | ComposioToolRule)[];
  expected: (string | ComposioToolRule)[];
}

/**
 * The page for `listed` at `address`, as `identity` sees it, recording each
 * change of tools sent to core, which answers once `answered` settles.
 */
const shown = async (
  listed: ListedConnection,
  {
    identity = person(),
    address = "/",
    answered = Promise.resolve(true),
    more = [],
    app = entry,
  }: {
    identity?: Identity;
    address?: string;
    answered?: Promise<boolean>;
    /** Its other accounts. */
    more?: ListedConnection[];
    /** The app, where it isn't HubSpot. */
    app?: OfferedCatalog["entries"][number];
  } = {}
): Promise<Sent[]> => {
  const sent: Sent[] = [];
  const connections = {
    changeTools: async (request: Sent): Promise<{ tools: string[] }> => {
      sent.push(request);
      await answered;
      return { tools: [] };
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { connections: typeof connections }) => Promise<T>
    ): Promise<T> => await action({ connections }),
  };
  const [integration] = integrationsOf([app], [listed, ...more]);
  if (integration === undefined) {
    throw new Error("No integration");
  }
  const rootRoute = createRootRoute({
    component: () => (
      <IntegrationAppPage
        identity={identity}
        integration={integration}
        tools={{ state: "ready", data: tools }}
        uses={{ state: "ready", data: [] }}
      />
    ),
  });
  history = createMemoryHistory({ initialEntries: [address] });
  const router = createRouter({
    routeTree: rootRoute,
    history,
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

/** What a reader hears of `element`: its text, leaving out what is hidden from them. */
const wordsOf = (element: Element): string => {
  const copy = element.cloneNode(true);
  if (!(copy instanceof Element)) {
    return "";
  }
  for (const hidden of copy.querySelectorAll("[aria-hidden='true']")) {
    hidden.remove();
  }
  return copy.textContent.trim();
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

/** The control of what Grasp may do with a group or a tool, by its name. */
const choiceOf = (name: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(
    `[aria-label="What Grasp may do: ${name}"]`
  );

/** Sets what Grasp may do with the group or tool `name` to `choice`, as a person does. */
const pick = async (name: string, choice: string): Promise<void> => {
  const control = choiceOf(name);
  if (control === null) {
    throw new TypeError(`No choice for ${name}`);
  }
  await press(control);
  const list = document.querySelector(
    `[id="${control.getAttribute("aria-controls") ?? ""}"]`
  );
  const option = [
    ...(list ?? document).querySelectorAll('[role="option"]'),
  ].find((each) => wordsOf(each).startsWith(choice));
  await press(option);
};

/** Opens the group `name` in place, to its tools: its row's name side is its disclosure. */
const openGroup = async (name: string): Promise<void> => {
  await press(
    [...document.querySelectorAll("button[aria-expanded]")].find((each) =>
      wordsOf(each).startsWith(name)
    )
  );
};

/** The page's first account row: its state, and how many buttons it has. */
const rowOf = () => {
  const row = document.querySelector<HTMLElement>('[data-slot="app-account"]');
  return {
    state: row?.dataset.state,
    buttons: row?.querySelectorAll("button").length,
  };
};

describe("changing what Grasp may do in a connected app", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    history = undefined;
    document.body.innerHTML = "";
  });

  it("sends the whole new choice for a group, with what the page showed", async () => {
    const sent = await shown(connection);
    const before = wordsOf(choiceOf("Notes") ?? document.body);
    await pick("Notes", "Write");

    expect({ before, sent }).toStrictEqual({
      // One note tool allowed, the other not.
      before: "Mixed",
      sent: [
        {
          connectionId: "connection-1",
          tools: [
            { name: "HUBSPOT_LIST_CONTACTS", read: true },
            "HUBSPOT_CREATE_NOTE",
            "HUBSPOT_DELETE_NOTE",
          ],
          expected: [
            { name: "HUBSPOT_LIST_CONTACTS", read: true },
            "HUBSPOT_CREATE_NOTE",
          ],
        },
      ],
    });
  });

  it("changes one tool on its own, keeping each tool's resource rule", async () => {
    const scoped = {
      ...connection,
      toolResources: {
        HUBSPOT_LIST_CONTACTS: "pipeline",
        HUBSPOT_CREATE_NOTE: "pipeline",
      },
    };
    const sent = await shown(scoped);
    await openGroup("Notes");
    await pick("Create note", "Never");

    expect(sent.map(({ tools: chosen }) => chosen)).toStrictEqual([
      [{ name: "HUBSPOT_LIST_CONTACTS", read: true, resource: "pipeline" }],
    ]);
  });

  it("lists a tool the toolkit no longer offers, which can still be taken away", async () => {
    const retired = {
      ...connection,
      tools: ["HUBSPOT_LIST_CONTACTS", "HUBSPOT_ARCHIVED_TOOL"],
    };
    const sent = await shown(retired);
    // A group of one stands with the rest under Other.
    await openGroup("Other");
    await pick("Archived tool", "Never");

    expect(sent).toStrictEqual([
      {
        connectionId: "connection-1",
        tools: [{ name: "HUBSPOT_LIST_CONTACTS", read: true }],
        expected: [
          { name: "HUBSPOT_LIST_CONTACTS", read: true },
          "HUBSPOT_ARCHIVED_TOOL",
        ],
      },
    ]);
  });

  it("keeps the last tool allowed", async () => {
    const one = { ...connection, tools: ["HUBSPOT_LIST_CONTACTS"] };
    const sent = await shown(one);
    await openGroup("Other");
    await pick("List contacts", "Never");

    expect(sent).toStrictEqual([]);
  });

  it("shows members and Grasp's staff what Grasp may do, with nothing to change", async () => {
    await shown(connection, { identity: person({ role: "user" }) });
    const member = {
      controls: document.querySelectorAll('[role="combobox"]').length,
      text: document.body.textContent,
    };
    act(() => {
      root?.unmount();
    });
    document.body.innerHTML = "";
    await shown(connection, { identity: person({ staff: true }) });
    const staff = document.querySelectorAll('[role="combobox"]').length;

    expect({
      member: member.controls,
      says: ["Mixed", "Read"].every((word) => member.text.includes(word)),
      staff,
    }).toStrictEqual({ member: 0, says: true, staff: 0 });
  });

  it("keeps a search changed while a change is sent, and drops only the flow's notice", async () => {
    const { promise: answered, resolve: answer } =
      Promise.withResolvers<boolean>();
    await shown(connection, {
      address: "/?q=hub&connection=connection-1",
      answered,
    });
    await pick("Notes", "Never");
    act(() => {
      history?.push("/?q=notes&show=connected&connection=connection-1");
    });
    await settled();
    answer(true);
    await settled();

    expect(history?.location.search).toBe("?q=notes&show=connected");
  });

  it("lists each account on its own row, with its own sign in again and disconnect", async () => {
    const microsoft: ListedConnection = {
      id: "connection-1",
      source: "native",
      provider: "microsoft",
      scope: "personal",
      status: "active",
      ownerUserId: "u1",
      connectedBy: "u1",
      connectedByName: "Ada",
      accountName: "sales@acme.test",
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    await shown(microsoft, {
      app: {
        ...entry,
        source: "native",
        id: "microsoft",
        name: "Microsoft 365",
      },
      more: [
        {
          ...microsoft,
          id: "connection-2",
          status: "needs_reauth",
          accountName: "ops@acme.test",
        },
      ],
    });
    const rows = [
      ...document.querySelectorAll<HTMLElement>('[data-slot="app-account"]'),
    ].map((row) => ({
      account: row.querySelector("[title]")?.getAttribute("title"),
      actions: [...row.querySelectorAll("button")].map(
        (button) => button.getAttribute("aria-label") ?? wordsOf(button)
      ),
    }));

    expect(rows).toStrictEqual([
      {
        account: "sales@acme.test",
        actions: ["Disconnect Microsoft 365 (sales@acme.test)"],
      },
      {
        account: "ops@acme.test",
        actions: [
          "Sign in to Microsoft 365 (ops@acme.test) again",
          "Disconnect Microsoft 365 (ops@acme.test)",
        ],
      },
    ]);
  });

  it("leaves disconnecting its one account to its row, not to the head's Manage menu", async () => {
    await shown(
      {
        id: "connection-1",
        source: "native",
        provider: "microsoft",
        scope: "personal",
        status: "active",
        ownerUserId: "u1",
        connectedBy: "u1",
        connectedByName: "Ada",
        accountName: "sales@acme.test",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
      {
        app: {
          ...entry,
          source: "native",
          id: "microsoft",
          name: "Microsoft 365",
        },
      }
    );
    const labelOf = (button: HTMLElement): string =>
      button.getAttribute("aria-label") ?? wordsOf(button);
    const row = document.querySelector('[data-slot="app-account"]');
    await press(
      [...document.querySelectorAll("button")].find(
        (button) => labelOf(button) === "Manage"
      )
    );

    expect({
      row: [...(row?.querySelectorAll("button") ?? [])].map(labelOf),
      menu: [...document.querySelectorAll('[role="menuitem"]')].map(wordsOf),
    }).toStrictEqual({
      row: ["Disconnect Microsoft 365 (sales@acme.test)"],
      menu: ["Connect another account"],
    });
  });

  it("leaves a row's buttons to who may use them: a member none on a shared account, Grasp staff none at all", async () => {
    const microsoft: ListedConnection = {
      id: "connection-1",
      source: "native",
      provider: "microsoft",
      scope: "shared",
      status: "needs_reauth",
      ownerUserId: null,
      connectedBy: "u2",
      connectedByName: "Bo",
      accountName: "ops@acme.test",
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    const app = {
      ...entry,
      source: "native" as const,
      id: "microsoft",
      name: "Microsoft 365",
    };
    await shown(microsoft, { app, identity: person({ role: "user" }) });
    const member = rowOf();
    act(() => {
      root?.unmount();
    });
    document.body.innerHTML = "";
    await shown(microsoft, { app, identity: person({ staff: true }) });
    const staff = rowOf();

    expect({ member, staff }).toStrictEqual({
      member: { state: "reconnect", buttons: 0 },
      staff: { state: "reconnect", buttons: 0 },
    });
  });

  it("opens signing in again from the row of the account whose access ran out", async () => {
    const lapsed: ListedConnection = {
      id: "connection-1",
      source: "native",
      provider: "microsoft",
      scope: "personal",
      status: "needs_reauth",
      ownerUserId: "u1",
      connectedBy: "u1",
      connectedByName: "Ada",
      accountName: "ops@acme.test",
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    await shown(lapsed, {
      app: {
        ...entry,
        source: "native",
        id: "microsoft",
        name: "Microsoft 365",
      },
    });
    await press(
      document.querySelector(
        '[aria-label="Sign in to Microsoft 365 (ops@acme.test) again"]'
      )
    );

    expect(
      [...document.querySelectorAll('[role="dialog"]')].map(
        (dialog) => dialog.querySelector("h2")?.textContent
      )
    ).toStrictEqual(["Sign in to Microsoft 365 again"]);
  });
});
