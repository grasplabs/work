// @vitest-environment happy-dom
import type { ChatCitedDocument } from "@grasp-os/shared/chat";
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

import { AnswerSources } from "./sources.tsx";

// The documents an answer cites, under it, against core's chats as the
// page reaches them over RPC, faked: what core says the answer cites,
// numbered in its order, each opening on its collection's page.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** Answer `messageId` of chat `chatId`, which core says cites `cited`. */
const shown = async (
  chatId: string,
  messageId: number,
  cited: Record<string, ChatCitedDocument[]>
) => {
  const asked: string[] = [];
  const chats = {
    cited: async (chat: string, message: number) => {
      asked.push(`${chat}/${message}`);
      await Promise.resolve();
      return cited[`${chat}/${message}`] ?? [];
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { chats: typeof chats }) => Promise<T>
    ): Promise<T> => await action({ chats }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const answer = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <AnswerSources chatId={chatId} messageId={messageId} />,
  });
  const collection = createRoute({
    getParentRoute: () => rootRoute,
    path: "/knowledge/$collection",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([answer, collection]),
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
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
  return { router, asked };
};

const plan: ChatCitedDocument = {
  documentId: "plan",
  collectionId: "plans",
  title: "Route plan",
  path: "routes/plan.md",
  snippet: "Where the route goes, and when.",
};

const leave: ChatCitedDocument = {
  documentId: "leave",
  collectionId: "handbook",
  title: "Parental leave",
  path: "leave.md",
  snippet: "Parental leave lasts sixteen weeks.",
};

describe(AnswerSources, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("numbers the documents the answer cites under it, each opening on its collection's page", async () => {
    const { router, asked } = await shown("chat", 7, {
      "chat/7": [plan, leave],
    });
    const listed = [...document.querySelectorAll("li")].map(
      (item) => item.textContent
    );
    const link = [...document.querySelectorAll("a")].find((each) =>
      each.textContent.includes("Parental leave")
    );

    await act(async () => {
      link?.click();
      await router.load();
    });

    expect({
      asked,
      listed,
      at: router.state.location.pathname,
      search: { ...router.state.location.search },
    }).toStrictEqual({
      asked: ["chat/7"],
      listed: [
        "1Route planroutes/plan.mdWhere the route goes, and when.",
        "2Parental leaveleave.mdParental leave lasts sixteen weeks.",
      ],
      at: "/knowledge/handbook",
      search: { doc: "leave" },
    });
  });

  it("shows nothing for an answer core says cites nothing it may show", async () => {
    await shown("chat", 8, {});

    expect(document.querySelector("ol")).toBeNull();
  });
});
