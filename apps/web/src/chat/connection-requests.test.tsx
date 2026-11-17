// @vitest-environment happy-dom
import type { ChatConnectionRequest } from "@grasp-os/shared/chat";
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

import { ConnectionRequests } from "./connection-requests.tsx";

// The connections a chat's agent asked to use, against core's chats as
// the page reaches them over RPC, faked: the person grants or denies their
// own connection, naming only the request; a shared one waits for an
// admin, and the person may withdraw it; a refusal is said on the card.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const own: ChatConnectionRequest = {
  id: "request-1",
  connectionId: "connection-1",
  provider: "Gmail",
  accountName: "sanne@acme.test",
  resource: null,
  actions: ["send"],
  binding: "sanne@acme.test",
  reason: "To send the invoice to Northwind.",
  requestedAt: "2026-11-17T10:00:00.000Z",
  decidedBy: "you",
};

const shared: ChatConnectionRequest = {
  ...own,
  id: "request-2",
  connectionId: "connection-2",
  provider: "Slack",
  accountName: "Acme",
  decidedBy: "admin",
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

/** The chat's connection requests, `asked`, against a core that refuses decisions when `refuse` says so. */
const shown = async (asked: ChatConnectionRequest[], refuse = false) => {
  const decided: string[] = [];
  const session = {
    chats: {
      connectionRequests: async (): Promise<ChatConnectionRequest[]> =>
        await Promise.resolve(
          asked.filter(({ id }) => !decided.some((each) => each.endsWith(id)))
        ),
      grantConnection: async (_chat: string, id: string): Promise<void> => {
        await Promise.resolve();
        if (refuse) {
          throw new Error("Someone decided meanwhile.");
        }
        decided.push(`grant ${id}`);
      },
      denyConnection: async (_chat: string, id: string): Promise<void> => {
        await Promise.resolve();
        if (refuse) {
          throw new Error("Someone decided meanwhile.");
        }
        decided.push(`deny ${id}`);
      },
    },
  };
  const core = {
    withSession: async <T,>(
      action: (reached: typeof session) => Promise<T>
    ): Promise<T> => await action(session),
  };
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <ConnectionRequests chatId="chat-1" version={0} />,
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
  return { decided };
};

/** Presses the button named `label`, by its words or its name. */
const press = async (label: string): Promise<void> => {
  const button = [...document.querySelectorAll("button")].find(
    (each) =>
      // A press's words, then what it says once pressed, hidden till then.
      each.textContent.trim().startsWith(label) ||
      each.getAttribute("aria-label") === label
  );
  if (button === undefined) {
    throw new TypeError(`No button ${label}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await settled();
};

describe("the chat's connection requests", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("grants the person's own connection, naming only the request, and the card goes", async () => {
    const { decided } = await shown([own]);
    const asked = document.body.textContent.includes(
      "Use Gmail, sanne@acme.test in this chat"
    );

    await press("Grant");

    expect({
      asked,
      decided,
      left: document.body.textContent.includes("Use Gmail"),
    }).toStrictEqual({
      asked: true,
      decided: ["grant request-1"],
      left: false,
    });
  });

  it("denies the person's own connection", async () => {
    const { decided } = await shown([own]);

    await press("Deny");

    expect(decided).toStrictEqual(["deny request-1"]);
  });

  it("lets the person withdraw a shared connection an admin decides, with nothing to grant", async () => {
    const { decided } = await shown([shared]);
    const grants = [...document.querySelectorAll("button")].filter((button) =>
      button.textContent.trim().startsWith("Grant")
    ).length;

    await press("Withdraw Slack, Acme");

    expect({ grants, decided }).toStrictEqual({
      grants: 0,
      decided: ["deny request-2"],
    });
  });

  it("says a grant core refused on the card, and keeps it", async () => {
    await shown([own], true);

    await press("Grant");

    expect({
      said: document.body.textContent.includes("Could not approve"),
      kept: document.body.textContent.includes("Use Gmail"),
    }).toStrictEqual({ said: true, kept: true });
  });
});
