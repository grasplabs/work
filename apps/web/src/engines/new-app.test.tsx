// @vitest-environment happy-dom
import type { ChatQuestion, ChatSummary } from "@grasp-os/shared/chat";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { forgetActiveChats } from "../chat/active-chat.ts";
import { NewApp } from "./new-app.tsx";

// The New app page against core's chats as the page reaches them over RPC
// (the boundary from the web app), faked: answering its question starts
// a chat carrying it, and opens that chat.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** Core's chat calls: what was made and asked, in order. */
const fakeChats = () => {
  const calls: string[] = [];
  return {
    calls,
    chats: {
      create: async (title: string): Promise<ChatSummary> => {
        calls.push(`create ${title}`);
        await Promise.resolve();
        return {
          id: "chat-1",
          title,
          createdAt: "2026-10-22T08:00:00.000Z",
          lastAt: "2026-10-22T08:00:00.000Z",
          running: false,
          projectId: null,
          appId: null,
        };
      },
      send: async (chatId: string, question: ChatQuestion) => {
        calls.push(`send ${chatId} ${question.text} (${question.model})`);
        await Promise.resolve();
      },
    },
  };
};

let root: Root | undefined;

/** The page at /apps/new, against `chats`; Chat at / says which chat it opened. */
const opened = async (chats: ReturnType<typeof fakeChats>["chats"]) => {
  const core = {
    withSession: async <T,>(
      action: (session: { chats: typeof chats }) => Promise<T>
    ): Promise<T> => await action({ chats }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({
    getParentRoute: () => rootRoute,
    id: "_shell",
    beforeLoad: () => ({ identity: { userId: "user-1" } }),
    component: Outlet,
  });
  const newApp = createRoute({
    getParentRoute: () => shell,
    path: "/apps/new",
    component: () => (
      <NewApp efforts={{}} models={["anthropic/claude", "openai/gpt"]} />
    ),
  });
  const chat = createRoute({
    getParentRoute: () => shell,
    path: "/",
    validateSearch: (search: Record<string, unknown>) => ({
      chat: typeof search.chat === "string" ? search.chat : undefined,
    }),
    component: () => <p>Chat {chat.useSearch().chat}</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([newApp, chat])]),
    history: createMemoryHistory({ initialEntries: ["/apps/new"] }),
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
  return router;
};

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

/** Types `value` into the question box, as React hears a person type. */
const typeQuestion = async (value: string): Promise<void> => {
  const box = document.querySelector("textarea");
  if (box === null) {
    throw new TypeError("No question box");
  }
  await act(async () => {
    const prototype = Reflect.getPrototypeOf(box) ?? {};
    Reflect.getOwnPropertyDescriptor(prototype, "value")?.set?.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};

const send = async (): Promise<void> => {
  const form = document.querySelector("form");
  await act(async () => {
    form?.requestSubmit();
    await Promise.resolve();
  });
  await settled();
};

describe("making a new app", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
    forgetActiveChats();
    localStorage.clear();
  });

  it("asks what the app should show, and opens a new chat carrying the answer", async () => {
    const { calls, chats } = fakeChats();
    const router = await opened(chats);
    const asked = document.querySelector("h1")?.textContent;

    await typeQuestion("A board of open invoices for the finance team");
    await send();

    expect({
      asked,
      calls,
      at: router.state.location.href,
      shown: document.body.textContent,
    }).toStrictEqual({
      asked: "What should the app show, and for whom?",
      calls: [
        "create A board of open invoices for the finance team",
        "send chat-1 A board of open invoices for the finance team (anthropic/claude)",
      ],
      at: "/?chat=chat-1",
      shown: "Chat chat-1",
    });
  });
});
