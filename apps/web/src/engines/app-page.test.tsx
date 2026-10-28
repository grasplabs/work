// @vitest-environment happy-dom
import type { ViewedApp } from "@grasp-os/shared/apps";
import type { ChatSummary } from "@grasp-os/shared/chat";
import { appIdSchema } from "@grasp-os/shared/ids";
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

import { activeChat, setActiveChat } from "../chat/active-chat.ts";
import { setDockMode, useDockMode } from "../chat/dock-mode.ts";
import { AppPage } from "./app-page.tsx";

// An App's page against core's chats as the page reaches them over RPC,
// faked: Edit, and "Design it in the chat" on an App with no screen yet,
// open the person's own chat for the App (`chats.forApp`) beside the
// page; what core refuses is said there, and no chat opens.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const app: ViewedApp = {
  id: appIdSchema.parse(crypto.randomUUID()),
  name: "Invoices",
  description: "",
  owner: "user-1",
  responsible: "user-1",
  audience: null,
  blueprint: null,
  currentVersion: 1,
  pendingVersion: null,
  status: "draft",
  link: null,
  createdAt: "2026-10-20T08:00:00.000Z",
  role: "builder",
};

const appChat: ChatSummary = {
  id: "chat-for-invoices",
  title: "Invoices",
  createdAt: "2026-10-20T08:00:00.000Z",
  lastAt: "2026-10-20T08:00:00.000Z",
  running: false,
  projectId: null,
  appId: app.id,
};

/** How the dock sits, as the page shows it. */
const Dock = () => <output data-dock>{useDockMode()}</output>;

/** The App's page, with `screens`, whose core answers `forApp` with `answer`. */
const shown = async (screens: string[], answer: () => Promise<ChatSummary>) => {
  const asked: string[] = [];
  const chats = {
    forApp: async (id: string) => {
      asked.push(id);
      return await answer();
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { chats: typeof chats }) => Promise<T>
    ): Promise<T> => await action({ chats }),
  };
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <>
          <AppPage
            app={app}
            contents={{ version: 1, screens, workflows: [] }}
            identity={{ staff: false }}
            open={screens[0]}
          >
            <p>The screen</p>
          </AppPage>
          <Dock />
        </>
      ),
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
  return { asked };
};

/** Presses the button named `name`, and lets core answer. */
const press = async (name: string): Promise<void> => {
  const button = [...document.querySelectorAll("button")].find(
    (each) => each.textContent === name
  );
  await act(async () => {
    button?.click();
    await Promise.resolve();
  });
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

const dock = () => document.querySelector("[data-dock]")?.textContent;

describe(AppPage, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    setActiveChat(undefined);
    setDockMode("bar");
  });

  it("opens the App's own chat beside the page from Edit", async () => {
    const { asked } = await shown(["home"], async () => {
      await Promise.resolve();
      return appChat;
    });

    await press("Edit");

    expect({ asked, chat: activeChat(), dock: dock() }).toStrictEqual({
      asked: [app.id],
      chat: appChat.id,
      dock: "frame",
    });
  });

  it("designs an App with no screen yet in its own chat", async () => {
    const { asked } = await shown([], async () => {
      await Promise.resolve();
      return appChat;
    });

    await press("Design it in the chat");

    expect({ asked, chat: activeChat(), dock: dock() }).toStrictEqual({
      asked: [app.id],
      chat: appChat.id,
      dock: "frame",
    });
  });

  it("says why when core gives no chat, and opens none", async () => {
    await shown(["home"], async () => {
      await Promise.resolve();
      throw Object.assign(new Error("There's no such App."), {
        code: "app.not_found",
      });
    });

    await press("Edit");

    expect({
      chat: activeChat(),
      dock: dock(),
      said: document.body.textContent.includes("There's no such App."),
    }).toStrictEqual({ chat: undefined, dock: "bar", said: true });
  });
});
