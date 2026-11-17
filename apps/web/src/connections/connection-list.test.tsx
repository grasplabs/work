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

/** An admin of the company. */
const admin: Identity = { ...person, role: "admin" };

/** A shared connection to Notes, connected by an admin. */
const shared = connection({ scope: "shared", ownerUserId: null });

/** What the page asked of core, by method, and its arguments. */
type Asked = [string, ...unknown[]][];

/**
 * Shows the shared connection `shown` to an admin, with core answering
 * its audience (`audience`) and the company's teams, and records what
 * the page asks it to change.
 */
const asAdmin = async (
  shown: CatalogConnection,
  audience?: { kind: string; teamId?: string }
): Promise<Asked> => {
  const asked: Asked = [];
  const session = {
    connections: {
      brainAudiences: async () =>
        await Promise.resolve(
          audience === undefined
            ? []
            : [
                {
                  connectionId: shown.id,
                  audience,
                  changedBy: "u2",
                  changedAt: "2026-11-17T08:00:00.000Z",
                },
              ]
        ),
      setBrainAudience: async (...given: unknown[]) => {
        asked.push(["setBrainAudience", ...given]);
        await Promise.resolve();
      },
      eraseBrainReads: async (...given: unknown[]) => {
        asked.push(["eraseBrainReads", ...given]);
        await Promise.resolve();
      },
    },
    organization: {
      teams: async () => await Promise.resolve([{ id: "t1", name: "Sales" }]),
    },
  };
  const core = {
    withSession: async <T,>(action: (given: unknown) => Promise<T>) =>
      await action(session),
  };
  const rootRoute = createRootRoute({
    component: () => (
      <ConnectionList
        held={undefined}
        identity={admin}
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
  // Its audience and the teams, read as the card opens.
  await act(async () => {
    await Promise.resolve();
  });
  return asked;
};

/** Chooses `value` in the card's Brain audience. */
const choose = async (value: string): Promise<void> => {
  const select = document.querySelector("select");
  await act(async () => {
    if (select !== null) {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await Promise.resolve();
  });
};

/** Presses the button whose text is `text`, in the dialog when there is one. */
const press = async (text: string): Promise<void> => {
  const button = [...document.querySelectorAll("button")].findLast(
    (each) => each.textContent === text
  );
  await act(async () => {
    button?.click();
    await Promise.resolve();
  });
};

/** The open dialog's text, or nothing. */
const dialogText = (): string =>
  document.querySelector('[role="dialog"]')?.textContent ?? "";

describe("a shared connection's Brain audience, for an admin", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("asks before it opens to everyone, saying what was kept before is shown too, and changes nothing when cancelled", async () => {
    const asked = await asAdmin(shared);
    await choose("everyone");
    const asking = dialogText();
    await press("Cancel");
    const afterCancel = [...asked];
    await choose("everyone");
    await press("Keep it for them");

    expect({
      asking: asking.includes(
        "Everyone in the company will be able to find what agents read through Notes, including what was kept before. Choose a team if not everyone should see it."
      ),
      afterCancel,
      asked,
    }).toStrictEqual({
      asking: true,
      afterCancel: [],
      asked: [["setBrainAudience", "c1", { kind: "everyone" }]],
    });
  });

  it("names the team when it opens to one, closes to nobody without asking, and erases only once confirmed", async () => {
    // Core says the Brain holds some of it (`keepsReads`), so it may be
    // erased whatever its audience is now.
    const asked = await asAdmin(
      connection({ scope: "shared", ownerUserId: null, keepsReads: true }),
      { kind: "everyone" }
    );
    // Narrowing from everyone to a team shows it to fewer: no question.
    await choose("t1");
    await choose("nobody");
    await press("Erase what the Brain kept");
    const erasing = dialogText();
    await press("Erase for good");
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    const fromNobody = await asAdmin(shared);
    await choose("t1");
    const toTeam = dialogText();

    expect({
      asked,
      erasing: erasing.includes("This can't be undone."),
      toTeam: toTeam.includes(
        "Everyone in Sales will be able to find what agents read through Notes, including what was kept before."
      ),
      fromNobody,
    }).toStrictEqual({
      asked: [
        ["setBrainAudience", "c1", { kind: "team", teamId: "t1" }],
        ["setBrainAudience", "c1", { kind: "nobody" }],
        ["eraseBrainReads", "c1"],
      ],
      erasing: true,
      toTeam: true,
      fromNobody: [],
    });
  });

  it("is never shown to someone who isn't an admin, nor on a person's own connection", async () => {
    await asAdmin(connection({}));
    const own = document.querySelector("select");
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    // The person, not an admin, on a shared connection.
    await disconnectDialog(shared);
    const member = document.querySelector("select");

    expect({ own, member }).toStrictEqual({ own: null, member: null });
  });
});
