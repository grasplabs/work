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

import { useAnswersPause } from "../answer-pause.tsx";
import { ConnectionRequests } from "./connection-requests.tsx";

// The connections a chat's agent asked to use, against core's chats as
// the page reaches them over RPC, faked: the person grants or denies their
// own connection, naming only the request, each press named for the
// connection it decides; a refusal is said on the card. A card that moves up
// into the place of one decided holds its answers a moment.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const own: ChatConnectionRequest = {
  id: "request-1",
  connectionId: "connection-1",
  name: "Gmail",
  accountName: "sanne@acme.test",
  resource: null,
  actions: ["send"],
  binding: "sanne@acme.test",
  reason: "To send the invoice to Northwind.",
  requestedAt: "2026-11-17T10:00:00.000Z",
};

const other: ChatConnectionRequest = {
  ...own,
  id: "request-3",
  connectionId: "connection-3",
  name: "Outlook",
  accountName: "sanne@acme.test",
};

let root: Root | undefined;

/** The requests with the pause the chat's answers share. */
const Requests = () => (
  <ConnectionRequests chatId="chat-1" pause={useAnswersPause()} version={0} />
);

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
      component: Requests,
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

/** The name a screen reader gives each button: its label, else its words. */
const buttonNames = (): string[] =>
  [...document.querySelectorAll("button")].map(
    (each) => each.getAttribute("aria-label") ?? each.textContent.trim()
  );

/** Presses the button named `label`. */
const press = async (label: string): Promise<void> => {
  const button = [...document.querySelectorAll("button")].find(
    (each) =>
      (each.getAttribute("aria-label") ?? each.textContent.trim()) === label
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

/** Waits out the moment the answers hold after a decision moved the cards. */
const pastThePause = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    // Longer than the pause (answer-pause.tsx).
    setTimeout(() => {
      resolve(true);
    }, 1100);
    await promise;
  });
};

/**
 * Whether the button `label` is held, out of use, and what it is described
 * by while it is, as a screen reader hears it.
 */
const holding = (label: string): { held: boolean; said: string } => {
  const button = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`
  );
  const said = (button?.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) =>
      id === "" ? "" : document.querySelector(`#${id}`)?.textContent
    )
    .join("");
  return {
    held:
      button !== null &&
      (button.disabled || button.getAttribute("aria-disabled") === "true"),
    said,
  };
};

/** The pause, as it is said. */
const pauseSaid =
  "Its answers can be used in a moment, so a press meant for the one before doesn't answer it.";

describe("the chat's connection requests", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("names each Grant and Deny for the connection it decides, so two requests read apart", async () => {
    await shown([own, other]);

    expect({
      names: buttonNames(),
      words: [...document.querySelectorAll("button")].map((button) =>
        button.textContent.trim()
      ),
    }).toStrictEqual({
      names: [
        "Deny Gmail, sanne@acme.test",
        "Grant Gmail, sanne@acme.test",
        "Deny Outlook, sanne@acme.test",
        "Grant Outlook, sanne@acme.test",
      ],
      words: ["Deny", "Grant", "Deny", "Grant"],
    });
  });

  it("grants the person's own connection, naming only the request, and the card goes", async () => {
    const { decided } = await shown([own, other]);
    const asked = document.body.textContent.includes(
      "Use Outlook, sanne@acme.test in this chat"
    );

    await press("Grant Outlook, sanne@acme.test");

    expect({
      asked,
      decided,
      left: document.body.textContent.includes("Use Outlook"),
      kept: document.body.textContent.includes("Use Gmail"),
    }).toStrictEqual({
      asked: true,
      decided: ["grant request-3"],
      left: false,
      kept: true,
    });
  });

  it("holds the answers of the request that moved into the place of one just granted, a moment", async () => {
    const { decided } = await shown([own, other]);
    await press("Grant Gmail, sanne@acme.test");
    const moved = holding("Grant Outlook, sanne@acme.test");
    // The second press of a double click, on what is now under the pointer.
    await press("Grant Outlook, sanne@acme.test");
    const pressedInThePause = [...decided];
    await pastThePause();
    await press("Grant Outlook, sanne@acme.test");

    expect({ moved, pressedInThePause, decided }).toStrictEqual({
      moved: { held: true, said: pauseSaid },
      pressedInThePause: ["grant request-1"],
      decided: ["grant request-1", "grant request-3"],
    });
  });

  it("denies the person's own connection", async () => {
    const { decided } = await shown([own]);

    await press("Deny Gmail, sanne@acme.test");

    expect(decided).toStrictEqual(["deny request-1"]);
  });

  it("says a grant core refused on the card, and keeps it", async () => {
    await shown([own], true);

    await press("Grant Gmail, sanne@acme.test");

    expect({
      said: document.body.textContent.includes("Someone decided meanwhile."),
      kept: document.body.textContent.includes("Use Gmail"),
    }).toStrictEqual({ said: true, kept: true });
  });
});
