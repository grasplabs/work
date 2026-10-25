// @vitest-environment happy-dom
import type { ChatSummary } from "@grasp-os/shared/chat";
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

import { ChatList } from "./chat-list.tsx";

// The chat list as the page shows core's list: chats are grouped by when
// they were last active, so an old chat someone just continued is under
// Today, not where it was started.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const aDay = 24 * 60 * 60 * 1000;

/** `days` days before now, as core sends a time. */
const daysBack = (days: number): string =>
  new Date(Date.now() - days * aDay).toISOString();

const chat = (
  title: string,
  createdAt: string,
  lastAt: string
): ChatSummary => ({
  id: title,
  title,
  createdAt,
  lastAt,
  running: false,
  projectId: null,
});

let root: Root | undefined;

/** The list of `chats`, as core lists them. */
const listed = async (chats: ChatSummary[]): Promise<void> => {
  const rootRoute = createRootRoute({
    component: () => (
      <ChatList activeId={undefined} chats={chats} projects={[]} />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory(),
    context: { core: {} },
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
};

/** Each period's heading, with the chats under it. */
const periods = (): Record<string, string[]> =>
  Object.fromEntries(
    [
      ...document.querySelectorAll(
        'section[aria-label="Chats by date"] > section'
      ),
    ].map((group) => [
      group.getAttribute("aria-label") ?? "",
      [...group.querySelectorAll("li a")].map(
        (link) => link.textContent?.trim() ?? ""
      ),
    ])
  );

describe("the chat list", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("groups chats by when they were last active, so a continued old chat is under Today", async () => {
    await listed([
      chat("Continued", daysBack(30), daysBack(0)),
      chat("Started today", daysBack(0), daysBack(0)),
      chat("This week", daysBack(3), daysBack(2)),
      chat("Quiet", daysBack(40), daysBack(10)),
    ]);

    expect(periods()).toStrictEqual({
      Today: ["Continued", "Started today"],
      "Last 7 days": ["This week"],
      Earlier: ["Quiet"],
    });
  });
});
