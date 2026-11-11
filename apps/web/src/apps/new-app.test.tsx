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

import { activeChat, appSlot, forgetActiveChats } from "../chat/active-chat.ts";
import { NewApp } from "./new-app.tsx";

// The New App page against core's Apps and chats as the page reaches them
// over RPC (the boundary from the web app), faked: what is asked makes the
// App, named after its first line, with its own chat (`chats.newApp`), asks
// it in that chat, and opens the App's workspace with it; a send that
// failed, sent again, asks in the same App rather than making another.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** Core's chat calls: what was made and asked, in order; `failing` sends refused. */
const fakeCore = (failing = 0, makeFailing = 0) => {
  const calls: string[] = [];
  let refusals = failing;
  let makeRefusals = makeFailing;
  let made = 0;
  return {
    calls,
    chats: {
      newApp: async ({
        name,
      }: {
        name: string;
      }): Promise<ChatSummary & { appId: string }> => {
        await Promise.resolve();
        if (makeRefusals > 0) {
          makeRefusals -= 1;
          throw new Error("Grasp can't make the App now.");
        }
        made += 1;
        calls.push(`new App ${name} with its chat`);
        return {
          id: `chat-${made}`,
          title: name,
          agentId: "organization",
          createdAt: "2026-10-22T08:00:00.000Z",
          lastAt: "2026-10-22T08:00:00.000Z",
          running: false,
          appId: `app-${made}`,
          via: "web",
        };
      },
      send: async (chatId: string, question: ChatQuestion) => {
        await Promise.resolve();
        if (refusals > 0) {
          refusals -= 1;
          throw new Error("Grasp is busy. Try again.");
        }
        calls.push(`send ${chatId} ${question.text} (${question.model})`);
      },
    },
  };
};

let root: Root | undefined;

/** The page at /apps/new, against `chats`; Chat at / says which chat it opened. */
const opened = async ({ chats }: ReturnType<typeof fakeCore>) => {
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
  const workspace = createRoute({
    getParentRoute: () => shell,
    path: "/apps/$app/edit",
    component: () => <p>The workspace</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([newApp, workspace])]),
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

  it("makes the App from what is asked, asks it in the App's own chat, and opens its workspace", async () => {
    const fake = fakeCore();
    const router = await opened(fake);
    const asked = document.querySelector("h1")?.textContent;

    await typeQuestion(
      "Open invoices board\nFor the finance team, by due date"
    );
    await send();

    expect({
      asked,
      calls: fake.calls,
      at: router.state.location.href,
      shown: document.body.textContent,
      chat: activeChat(appSlot("app-1")),
      personsChat: activeChat(),
    }).toStrictEqual({
      asked: "What do you want to build?",
      calls: [
        "new App Open invoices board with its chat",
        "send chat-1 Open invoices board\nFor the finance team, by due date (anthropic/claude)",
      ],
      at: "/apps/app-1/edit",
      shown: "The workspace",
      chat: "chat-1",
      personsChat: undefined,
    });
  });

  it("asks again in the App it made when the first send failed, making no second App", async () => {
    const fake = fakeCore(1);
    const router = await opened(fake);

    await typeQuestion("Holiday planner");
    await send();
    const failed = {
      at: router.state.location.href,
      said: document.body.textContent.includes("Grasp is busy. Try again."),
    };
    await send();

    expect({
      failed,
      calls: fake.calls,
      at: router.state.location.href,
    }).toStrictEqual({
      failed: { at: "/apps/new", said: true },
      calls: [
        "new App Holiday planner with its chat",
        "send chat-1 Holiday planner (anthropic/claude)",
      ],
      at: "/apps/app-1/edit",
    });
  });

  it("makes the App when asked again after core couldn't make it, asking in that one", async () => {
    const fake = fakeCore(0, 1);
    const router = await opened(fake);

    await typeQuestion("Holiday planner");
    await send();
    const failed = router.state.location.href;
    await send();

    expect({
      failed,
      calls: fake.calls,
      at: router.state.location.href,
    }).toStrictEqual({
      failed: "/apps/new",
      calls: [
        "new App Holiday planner with its chat",
        "send chat-1 Holiday planner (anthropic/claude)",
      ],
      at: "/apps/app-1/edit",
    });
  });
});
