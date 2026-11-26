// @vitest-environment happy-dom
import type { ListedConnection } from "@grasp-os/shared/connect";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ConnectedDialog, returnedOf } from "./connected-dialog.tsx";

// The success page a flow ends on, once the provider sent the person
// back: what was connected, whether again, what was chosen, and Close.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// Someone who asked for less motion: the page stands still, and the test
// reads it without waiting on animations the test DOM can't run.
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

const connection = (
  change: Partial<ListedConnection> = {}
): ListedConnection => ({
  id: "c1",
  source: "native",
  provider: "microsoft",
  scope: "personal",
  status: "active",
  ownerUserId: "u1",
  connectedBy: "u1",
  connectedByName: "Ada",
  accountName: "ada@example.com",
  createdAt: "2026-10-22T08:00:00.000Z",
  ...change,
});

let root: Root | undefined;

/** The page for `shown`, counting how often it was closed. */
const opened = async (
  shown?: ListedConnection,
  { app = "Microsoft 365", again = false } = {}
): Promise<{ closed: number }> => {
  const closes = { closed: 0 };
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <ConnectedDialog
          again={again}
          app={app}
          connection={shown}
          onClose={() => {
            closes.closed += 1;
          }}
        />
      </I18nProvider>
    );
    await Promise.resolve();
  });
  return closes;
};

const dialog = (): HTMLElement | null =>
  document.querySelector('[role="dialog"]');

describe("the page a connection ends on", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("says the app is connected, that Grasp may read and write there, and for whom", async () => {
    await opened(connection());
    expect(dialog()?.textContent).toContain("Microsoft 365 is connected");
    expect(dialog()?.textContent).toContain(
      "Grasp may read and write in Microsoft 365"
    );
    expect(dialog()?.textContent).toContain("Just for you");
  });

  it("says where a connection reached through the company network goes", async () => {
    await opened(
      connection({
        source: "connector",
        provider: `mcp_${"0".repeat(32)}`,
        scope: "shared",
        ownerUserId: null,
        accountName: null,
        companyNetwork: "http://10.0.0.8:8080",
      }),
      { app: "Ledger" }
    );
    expect(dialog()?.textContent).toContain("For the company");
    expect(dialog()?.textContent).toContain(
      "Reached through your company network"
    );
    expect(dialog()?.textContent).toContain(
      "Grasp reaches it at http://10.0.0.8:8080, inside your network."
    );
  });

  it("says connected again after signing in again", async () => {
    await opened(connection(), { again: true });
    expect(dialog()?.textContent).toContain("Microsoft 365 is connected again");
  });

  it("lists the tools allowed on a toolkit shared with everyone", async () => {
    await opened(
      connection({
        source: "composio",
        provider: "hubspot",
        scope: "shared",
        tools: ["HUBSPOT_LIST_CONTACTS", "HUBSPOT_CREATE_NOTE"],
      }),
      { app: "HubSpot" }
    );
    const items = [
      ...(dialog()?.querySelectorAll('[data-slot="item"]') ?? []),
    ].map((each) => each.textContent);
    expect(items).toStrictEqual([
      expect.stringContaining("For the company"),
      "HUBSPOT_LIST_CONTACTS",
      "HUBSPOT_CREATE_NOTE",
    ]);
  });

  it("closes from its Close button", async () => {
    const closes = await opened(connection());
    const close = [...(dialog()?.querySelectorAll("button") ?? [])].find(
      (each) => each.textContent === "Close"
    );
    await act(async () => {
      close?.click();
      await Promise.resolve();
    });
    expect(closes.closed).toBe(1);
  });

  it("shows nothing without a connection the page lists", async () => {
    await opened();
    expect(dialog()).toBeNull();
  });
});

describe("whether a connection connected its app again", () => {
  const shared = (
    id: string,
    status: ListedConnection["status"],
    accountName: string | null,
    change: Partial<ListedConnection> = {}
  ): ListedConnection =>
    connection({
      id,
      status,
      accountName,
      scope: "shared",
      ownerUserId: null,
      ...change,
    });

  it("is again only beside a stopped connection of the same account, or of a toolkit that names none", () => {
    const made = shared("new", "active", "ada@example.com");
    const toolkit = { source: "composio", provider: "hubspot" } as const;
    expect({
      sameAccount: returnedOf(
        [made, shared("old", "needs_reauth", "ada@example.com")],
        "new"
      ).again,
      anotherAccount: returnedOf(
        [made, shared("old", "needs_reauth", "bob@example.com")],
        "new"
      ).again,
      personalStopped: returnedOf(
        [
          made,
          connection({
            id: "old",
            status: "needs_reauth",
            accountName: "ada@example.com",
          }),
        ],
        "new"
      ).again,
      toolkit: returnedOf(
        [
          shared("new", "active", null, toolkit),
          shared("old", "needs_reauth", null, toolkit),
        ],
        "new"
      ).again,
    }).toStrictEqual({
      sameAccount: true,
      anotherAccount: false,
      personalStopped: false,
      toolkit: true,
    });
  });
});
