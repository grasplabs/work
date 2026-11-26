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

import { AddConnector } from "./add-connector.tsx";

// Adding a connector by URL against core's connections as the page reaches
// them over RPC, faked: a server reached through the company network is
// sent as one, with a key in a header, and plain HTTP is refused for any
// other before it reaches core.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// Someone who asked for less motion: the dialog stands still, and the test
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

const admin: Identity = {
  userId: "u1",
  email: "ada@example.com",
  name: "Ada",
  role: "admin",
  teams: [],
  staff: false,
  expiresAt: "2026-12-31T00:00:00.000Z",
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

const button = (text: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === text
  );

/** The dialog open, recording what adding sends to core, which refuses it. */
const opened = async (): Promise<unknown[]> => {
  const sent: unknown[] = [];
  const connections = {
    addConnector: async (request: unknown): Promise<{ id: string }> => {
      sent.push(request);
      // Refused, so the dialog stays open for the test to read.
      return await Promise.reject(new Error("Not now"));
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { connections: typeof connections }) => Promise<T>
    ): Promise<T> => await action({ connections }),
  };
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <AddConnector identity={admin} />,
    }),
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
  await press(button("Add connector"));
  return sent;
};

/** The text field labelled \`label\`. */
const field = (label: string): HTMLInputElement => {
  const found = [...document.querySelectorAll("label")]
    .find((each) => each.textContent?.trim() === label)
    ?.closest('[data-slot="field"]')
    ?.querySelector("input");
  if (!(found instanceof HTMLInputElement)) {
    throw new TypeError(`No field ${label}`);
  }
  return found;
};

/** Types `text` into `input`, as a person would. */
const type = async (input: HTMLInputElement, text: string): Promise<void> => {
  await act(async () => {
    Reflect.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await settled();
};

const dialog = (): HTMLElement | null =>
  document.querySelector('[role="dialog"]');

describe("adding a connector by URL", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("sends a server reached through the company network as one, signing in with a key in a header", async () => {
    const sent = await opened();
    await press(dialog()?.querySelector('[role="checkbox"]'));
    expect(dialog()?.textContent).not.toContain("How it signs in");
    expect(dialog()?.textContent).toContain(
      "An IP address is safer than a name"
    );

    await type(field("Name"), "Ledger");
    await type(field("Server URL"), "http://10.0.0.8:8080/mcp");
    await type(field("Header name"), "x-api-key");
    await press(button("Add the connector"));
    expect(sent).toStrictEqual([
      {
        name: "Ledger",
        url: "http://10.0.0.8:8080/mcp",
        companyNetwork: true,
        auth: { kind: "header", header: "x-api-key" },
      },
    ]);
  });

  it("says a name holds a character that doesn't show, not that it is too long, sending nothing", async () => {
    const sent = await opened();
    await type(field("Name"), "Lin\u200Bear");
    await type(field("Server URL"), "https://mcp.example.com/mcp");
    await press(button("Add the connector"));
    expect(sent).toStrictEqual([]);
    expect(dialog()?.textContent).toContain(
      "The name holds a character that doesn't show"
    );
  });

  it("refuses plain HTTP for a server on the public internet, sending nothing", async () => {
    const sent = await opened();
    await type(field("Name"), "Ledger");
    await type(field("Server URL"), "http://mcp.example.com/mcp");
    await press(button("Add the connector"));
    expect(sent).toStrictEqual([]);
    expect(dialog()?.textContent).toContain(
      "The address is the server's own https:// URL"
    );
  });
});
