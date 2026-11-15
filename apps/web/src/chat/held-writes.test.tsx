// @vitest-environment happy-dom
import { heldAppCallsPage } from "@grasp-os/shared/chat";
import type { HeldAppCall } from "@grasp-os/shared/chat";
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

import { HeldWrites } from "./held-writes.tsx";

// A write to an App held because the chat used something only the person
// can read (held-app-calls.ts in core), against core's chats and pending
// actions as the page reaches them over RPC, faked: the card says why it
// waits and shows exactly the request that would run, before anything is
// pressed; confirming names that request's hash, and rejecting runs
// nothing.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const request = JSON.stringify({
  reference: { name: "notes.create", kind: "mutation" },
  args: { title: "My salary is 4,200 a month" },
});

const held: HeldAppCall = {
  id: "held-1",
  appId: "app-1",
  appName: "Notes",
  function: "notes.create",
  kind: "mutation",
  request,
  requestHash: "b".repeat(64),
  heldAt: "2026-11-15T10:00:00.000Z",
  expiresAt: "2026-11-16T10:00:00.000Z",
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

/**
 * The chat's held writes against a core holding `holds` (`held` alone by
 * default) until one is decided, a page of `heldAppCallsPage` at a time.
 */
const shown = async (holds: readonly HeldAppCall[] = [held]) => {
  const confirmed: { chatId: string; id: string; requestHash: string }[] = [];
  const declined: { chatId: string; id: string }[] = [];
  const session = {
    chats: {
      heldCalls: async (
        _chatId: string,
        after?: string
      ): Promise<HeldAppCall[]> => {
        const waiting = confirmed.length + declined.length === 0 ? holds : [];
        const from =
          after === undefined
            ? 0
            : waiting.findIndex(({ id }) => id === after) + 1;
        return await Promise.resolve(
          waiting.slice(from, from + heldAppCallsPage)
        );
      },
      confirmHeldCall: async (
        chatId: string,
        id: string,
        requestHash: string
      ): Promise<void> => {
        await Promise.resolve();
        confirmed.push({ chatId, id, requestHash });
      },
      declineHeldCall: async (chatId: string, id: string): Promise<void> => {
        await Promise.resolve();
        declined.push({ chatId, id });
      },
    },
    pendingActions: { list: async () => await Promise.resolve([]) },
  };
  const core = {
    withSession: async <T,>(
      action: (reached: typeof session) => Promise<T>
    ): Promise<T> => await action(session),
  };
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <HeldWrites chatId="chat-1" version={0} />,
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
  return { confirmed, declined };
};

const press = async (label: string): Promise<void> => {
  const button = document.querySelector(`button[aria-label="${label}"]`);
  if (!(button instanceof HTMLButtonElement)) {
    throw new TypeError(`No button ${label}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await settled();
};

describe("a write to an App held for the person", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("says why it waits and shows exactly what would run, then confirms exactly that request", async () => {
    const { confirmed, declined } = await shown();
    const text = document.body.textContent ?? "";
    const exact: unknown = JSON.parse(
      document.querySelector("pre code")?.textContent ?? ""
    );
    const sent: unknown = JSON.parse(request);
    const seen = {
      why: text.includes("This uses something only you can read"),
      what: text.includes("Waiting for you: notes.create in Notes"),
      exact,
    };
    await press("Confirm notes.create in Notes");

    expect({
      seen,
      confirmed,
      declined,
      after: document.body.textContent,
    }).toStrictEqual({
      seen: { why: true, what: true, exact: sent },
      confirmed: [
        { chatId: "chat-1", id: "held-1", requestHash: held.requestHash },
      ],
      declined: [],
      after: "",
    });
  });

  it("runs nothing once it is rejected", async () => {
    const { confirmed, declined } = await shown();
    await press("Reject notes.create in Notes");

    expect({ confirmed, declined }).toStrictEqual({
      confirmed: [],
      declined: [{ chatId: "chat-1", id: "held-1" }],
    });
  });

  it("shows every hold of the chat, however many pages they take", async () => {
    const holds = Array.from({ length: heldAppCallsPage + 1 }, (_, at) => ({
      ...held,
      id: `held-${at}`,
      function: `notes.create${at}`,
    }));
    await shown(holds);

    expect(
      document.querySelectorAll('article[aria-label^="notes.create"]')
    ).toHaveLength(heldAppCallsPage + 1);
  });
});
