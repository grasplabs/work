// @vitest-environment happy-dom
import { composioConsentText } from "@grasp-os/shared/connect";
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
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { IntegrationPanel } from "./integration-panel.tsx";
import { integrationsOf } from "./integrations.ts";
import type { Integration } from "./integrations.ts";

// One app's panel over the Integrations page, on the library's app panel,
// against core's connections as the page reaches them over RPC, faked: an
// admin connects a Composio toolkit in the library's consent dialog, for
// everyone, consenting to its text word for word, and connecting sends the
// tools chosen (reads on, changes off, to start) and that text;
// members and Grasp's staff get nothing to connect it with; Microsoft 365
// connects in the library's connect dialog, for everyone where an admin
// chooses it and otherwise for the person alone, saying where they'll sign
// in, busy until the sign-in starts and saying in the dialog why it didn't;
// a stopped toolkit is connected again beside its stopped connection,
// which nothing disconnects; one that takes a key offers Manage and
// Disconnect, saying its stopped key goes first; and whoever may sign in to
// a lapsed native connection again finds it under Manage.

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
];

const entry = (
  source: "native" | "composio",
  id: string,
  name: string
): OfferedCatalog["entries"][number] => ({
  source,
  id,
  name,
  categories: ["CRM"],
  toolCount: tools.length,
  logo: null,
  description: `${name}, in a sentence.`,
  group: "Other",
  auth: "managed",
  offered: true,
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

/** What connecting a toolkit sends to core, and each disconnect before it. */
interface Sent {
  toolkit: string;
  tools: (string | ComposioToolRule)[];
  consent: string;
  returnTo?: string;
}

/** What starting a native provider's sign-in sends to core. */
interface Started {
  provider: string;
  scope: string;
  returnTo: string;
}

/** What the faked core's connections answer: each recorded in `sent`, connecting refused unless a test says otherwise. */
const connectionsApi = (
  sent: (Sent | Started | { disconnected: string })[],
  given: {
    catalogTools?: () => Promise<CatalogTool[]>;
    connectToolkit?: (request: Sent) => Promise<{ url: string }>;
    start?: (request: Started) => Promise<{ url: string }>;
    disconnect?: (connectionId: string) => Promise<{ revoked: boolean }>;
  } = {}
) => ({
  disconnect: async (connectionId: string): Promise<{ revoked: boolean }> => {
    sent.push({ disconnected: connectionId });
    return await (given.disconnect?.(connectionId) ??
      Promise.resolve({ revoked: true }));
  },
  catalogTools:
    given.catalogTools ??
    (async (): Promise<CatalogTool[]> => await Promise.resolve(tools)),
  connectToolkit: async (request: Sent): Promise<{ url: string }> => {
    sent.push(request);
    // Refused, so the browser stays here for the test to read.
    return await (given.connectToolkit?.(request) ??
      Promise.reject(new Error("Not now")));
  },
  start: async (request: Started): Promise<{ url: string }> => {
    sent.push(request);
    return await (given.start?.(request) ??
      Promise.reject(new Error("Not now")));
  },
});

/** A faked core that hands `api` to every session. */
const coreOf = (api: object) => ({
  withSession: async <T,>(
    action: (session: { connections: typeof api }) => Promise<T>
  ): Promise<T> => await action({ connections: api }),
});

/** The integration `id` with `connections`, as the page lists it. */
const integrationOf = (
  id: string,
  connections: ListedConnection[]
): Integration => {
  const integration = integrationsOf(
    [
      entry("composio", "hubspot", "HubSpot"),
      { ...entry("composio", "airtable", "Airtable"), auth: "key" },
      entry("native", "microsoft", "Microsoft 365"),
    ],
    connections
  ).find((each) => each.id === id);
  if (integration === undefined) {
    throw new Error(`No ${id}`);
  }
  return integration;
};

/** Draws `element` in a router whose context holds `core`. */
const mounted = async (element: ReactElement, core: object): Promise<void> => {
  const rootRoute = createRootRoute({ component: () => element });
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

/** The panel of `id`, as `identity` sees it, recording what it sends to core. */
const opened = async (
  id: string,
  connections: ListedConnection[],
  identity: Identity = person(),
  given: { core?: object } & Parameters<typeof connectionsApi>[1] = {}
): Promise<(Sent | Started | { disconnected: string })[]> => {
  const sent: (Sent | Started | { disconnected: string })[] = [];
  const core = given.core ?? coreOf(connectionsApi(sent, given));
  await mounted(
    <IntegrationPanel
      identity={identity}
      integration={integrationOf(id, connections)}
      onClose={() => {
        // The test reads the panel, not it closing.
      }}
      uses={Promise.resolve({ state: "ready", data: [] })}
    />,
    core
  );
  return sent;
};

/** Unmounts what a test drew, for it to draw the page anew. */
const unmounted = (): void => {
  act(() => {
    root?.unmount();
  });
  document.body.innerHTML = "";
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

/** The buttons named `text`, by their label or their words, wherever they stand (the panel and its dialog are layers of their own). */
const buttons = (text: string): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>("button, [role=menuitem]")].filter(
    (each) =>
      (each.getAttribute("aria-label") ?? each.textContent.trim()) === text
  );

/**
 * A dialog's action, which carries its working and failed words too: the
 * last such button in a dialog, as the dialog stands over the panel and
 * its Connect.
 */
const dialogAction = (text: string): HTMLElement | undefined =>
  [
    ...document.querySelectorAll<HTMLElement>(
      '[role="dialog"] button, [role="alertdialog"] button'
    ),
  ].findLast((each) => each.textContent.startsWith(text));

/** The open dialog titled `title`. */
const dialogOf = (title: string): Element | undefined =>
  [...document.querySelectorAll('[role="dialog"]')].find((each) =>
    each.textContent.includes(title)
  );

/** A HubSpot connection that stopped working, with what it allowed. */
const stopped: ListedConnection = {
  id: "c-hubspot",
  source: "composio",
  provider: "hubspot",
  scope: "shared",
  status: "needs_reauth",
  ownerUserId: null,
  connectedBy: "u1",
  connectedByName: "Ada",
  accountName: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  // A tool the catalog no longer lists starts off, not as it was.
  tools: ["HUBSPOT_LIST_CONTACTS", "HUBSPOT_CREATE_NOTE", "HUBSPOT_DROPPED"],
  readTools: ["HUBSPOT_LIST_CONTACTS"],
  toolResources: { HUBSPOT_CREATE_NOTE: "contactId" },
};

describe("an app's panel", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("has an admin connect a toolkit for everyone, consenting to its text word for word", async () => {
    const sent = await opened("hubspot", []);
    await press(buttons("Connect")[0]);
    const dialog = dialogOf("Connect HubSpot");
    const shown = {
      consent: dialog?.textContent.includes(composioConsentText) ?? false,
      // Who uses a toolkit isn't asked: it is always everyone.
      forEveryone: dialog?.textContent.includes("Everyone") ?? false,
      choice: buttons("Just you").length,
    };
    // Every tool may change things too, asking first: none goes as a read.
    await press(
      document.querySelector('[aria-label="What Grasp may do: All tools"]')
    );
    await press(
      [...document.querySelectorAll('[role="option"]')].find((each) =>
        each.textContent.startsWith("Write")
      )
    );
    await press(dialogAction("Connect"));

    expect({
      shown,
      sent,
      // Refused, it stays open and says so on its Connect.
      failed: dialogAction("Connect")?.dataset.status === "error",
    }).toStrictEqual({
      shown: { consent: true, forEveryone: true, choice: 0 },
      sent: [
        {
          toolkit: "hubspot",
          tools: ["HUBSPOT_LIST_CONTACTS", "HUBSPOT_CREATE_NOTE"],
          consent: composioConsentText,
          returnTo: "/integrations/composio:hubspot",
        },
      ],
      failed: true,
    });
  });

  it("has an admin connect a stopped toolkit again from what it allowed, disconnecting nothing when connecting is refused", async () => {
    const sent = await opened("hubspot", [stopped]);
    await press(buttons("Connect again")[0]);
    await press(dialogAction("Connect"));

    expect({
      sent: sent.map((each) => ("toolkit" in each ? each.tools : each)),
      said: dialogOf("Connect HubSpot again")?.querySelector('[role="alert"]')
        ?.textContent,
    }).toStrictEqual({
      // Only the connect: the stopped connection stays, with its consent, its Brain audience and its permissions.
      sent: [
        [
          { name: "HUBSPOT_LIST_CONTACTS", read: true },
          { name: "HUBSPOT_CREATE_NOTE", resource: "contactId" },
        ],
      ],
      said: "Not now",
    });
  });

  it("says connecting a stopped toolkit again makes a new connection beside the stopped one, and leaves for the sign-in disconnecting nothing", async () => {
    const assign = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => {
        // The browser stays here for the test to read.
      });
    const sent = await opened("hubspot", [stopped], person(), {
      connectToolkit: async () =>
        await Promise.resolve({ url: "https://composio.example/sign-in" }),
    });
    await press(buttons("Connect again")[0]);
    const says = dialogOf("Connect HubSpot again")?.textContent ?? "";
    await press(dialogAction("Connect"));

    expect({
      says: {
        stays: says.includes(
          "The one that stopped stays until it is disconnected."
        ),
        fresh: says.includes(
          "The new one starts fresh: you consent to it again, and nobody may read in the Brain what agents read through it until you choose who may."
        ),
        consent: says.includes(composioConsentText),
      },
      to: assign.mock.calls.map(([url]) => url),
      returnTo: sent.flatMap((each) =>
        "returnTo" in each ? [each.returnTo] : []
      ),
      disconnected: sent.filter((each) => "disconnected" in each),
    }).toStrictEqual({
      says: { stays: true, fresh: true, consent: true },
      to: ["https://composio.example/sign-in"],
      returnTo: ["/integrations/composio:hubspot"],
      disconnected: [],
    });
  });

  it("offers a toolkit whose key stopped working Manage and Disconnect, saying the key goes before a new one", async () => {
    const key: ListedConnection = {
      ...stopped,
      id: "c-airtable",
      provider: "airtable",
    };
    const sent = await opened("airtable", [key]);
    const offered = {
      connect: [...buttons("Connect again"), ...buttons("Connect")].length,
      says: document.body.textContent.includes(
        "The key that stopped working must be disconnected before a new one can be added."
      ),
    };
    await press(buttons("Manage")[0]);
    await press(buttons("Disconnect")[0]);
    await press(dialogAction("Disconnect"));

    expect({ offered, sent }).toStrictEqual({
      offered: { connect: 0, says: true },
      sent: [{ disconnected: "c-airtable" }],
    });
  });

  it("tells a member nothing of a stopped key's removal, and offers them nothing to do", async () => {
    const key: ListedConnection = {
      ...stopped,
      id: "c-airtable",
      provider: "airtable",
    };
    await opened("airtable", [key], person({ role: "user" }));

    expect({
      says: document.body.textContent.includes("must be disconnected"),
      actions: [
        ...buttons("Manage"),
        ...buttons("Connect again"),
        ...buttons("Disconnect"),
      ].length,
    }).toStrictEqual({ says: false, actions: 0 });
  });

  it("has an admin connect Microsoft 365 for everyone, saying where they'll sign in", async () => {
    const sent = await opened("microsoft", []);
    await press(buttons("Connect")[0]);
    const where = dialogOf("Connect Microsoft 365")?.textContent.includes(
      "login.microsoftonline.com"
    );
    await press(buttons("Everyone")[0]);
    await press(dialogAction("Sign in to Microsoft 365"));

    expect({
      where,
      sent,
      // Refused: the dialog says why, beside its Sign in.
      said: dialogOf("Connect Microsoft 365")?.querySelector('[role="alert"]')
        ?.textContent,
    }).toStrictEqual({
      where: true,
      said: "Not now",
      sent: [
        {
          provider: "microsoft",
          scope: "shared",
          returnTo: "/integrations/native:microsoft",
        },
      ],
    });
  });

  it("starts one sign-in for a second press while the first is under way", async () => {
    const answer = Promise.withResolvers<{ url: string }>();
    const sent = await opened("microsoft", [], person(), {
      start: async () => await answer.promise,
    });
    await press(buttons("Connect")[0]);
    await press(dialogAction("Sign in to Microsoft 365"));
    const busy = dialogAction("Sign in to Microsoft 365")?.getAttribute(
      "aria-busy"
    );
    await press(dialogAction("Sign in to Microsoft 365"));
    answer.reject(new Error("Not now"));
    await settled();

    expect({ busy, starts: sent.length }).toStrictEqual({
      busy: "true",
      starts: 1,
    });
  });

  it("has a member connect Microsoft 365 for themselves alone, with no choice", async () => {
    const sent = await opened("microsoft", [], person({ role: "user" }));
    await press(buttons("Connect")[0]);
    const choice = buttons("Everyone").length;
    await press(dialogAction("Sign in to Microsoft 365"));

    expect({ choice, sent }).toStrictEqual({
      choice: 0,
      sent: [
        {
          provider: "microsoft",
          scope: "personal",
          returnTo: "/integrations/native:microsoft",
        },
      ],
    });
  });

  it("gives members and Grasp's staff nothing to connect a toolkit with", async () => {
    await opened("hubspot", [], person({ role: "user" }));
    const member = buttons("Connect").length;
    unmounted();
    await opened("hubspot", [], person({ staff: true }));
    const staff = buttons("Connect").length;

    expect({ member, staff }).toStrictEqual({ member: 0, staff: 0 });
  });

  it("offers signing in again to a lapsed native connection under Manage", async () => {
    await opened("microsoft", [
      {
        id: "c1",
        source: "native",
        provider: "microsoft",
        scope: "personal",
        status: "needs_reauth",
        ownerUserId: "u1",
        connectedBy: "u1",
        connectedByName: "Ada",
        accountName: "ada@example.com",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    ]);
    await press(buttons("Manage")[0]);
    await press(buttons("Sign in again")[0]);

    expect(document.body.textContent).toContain(
      "Sign in to Microsoft 365 again"
    );
  });

  it("disconnects its one account under Manage, as the panel has no rows", async () => {
    const sent = await opened("microsoft", [
      {
        id: "c1",
        source: "native",
        provider: "microsoft",
        scope: "personal",
        status: "active",
        ownerUserId: "u1",
        connectedBy: "u1",
        connectedByName: "Ada",
        accountName: "ada@example.com",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    ]);
    await press(buttons("Manage")[0]);
    await press(buttons("Disconnect")[0]);
    await press(dialogAction("Disconnect"));

    expect(sent).toStrictEqual([{ disconnected: "c1" }]);
  });

  it("reads an app's tools again on the next open when a read failed, in the same tab", async () => {
    let reads = 0;
    const flaky = async (): Promise<CatalogTool[]> => {
      reads += 1;
      if (reads === 1) {
        throw new Error("Core can't be reached");
      }
      return await Promise.resolve(tools);
    };
    const core = {
      withSession: async <T,>(
        action: (session: { connections: object }) => Promise<T>
      ): Promise<T> => await action({ connections: { catalogTools: flaky } }),
    };
    await opened("hubspot", [], person(), { core, catalogTools: flaky });
    const first = document.body.textContent.includes("All 2 tools");
    unmounted();
    await opened("hubspot", [], person(), { core, catalogTools: flaky });

    expect({
      reads,
      first,
      again: document.body.textContent.includes("All 2 tools"),
    }).toStrictEqual({ reads: 2, first: false, again: true });
  });
});
