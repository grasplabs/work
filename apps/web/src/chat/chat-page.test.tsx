// @vitest-environment happy-dom

import { agentErrors } from "@grasp-os/shared/agent";
import type { ChatQuestion, ChatSummary } from "@grasp-os/shared/chat";
import { internalErrors } from "@grasp-os/shared/errors";
import type { Identity } from "@grasp-os/shared/rpc";
import { SidebarProvider } from "@grasp-os/ui/components/sidebar";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  getRouteApi,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadFromCore } from "../load-from-core.tsx";
import { wordsOf } from "../test-words.ts";
import { activeChat, setActiveChat } from "./active-chat.ts";
import { LoadedChatPage } from "./chat-page.tsx";
import { GlobalChatProvider, useGlobalChat } from "./global-chat.tsx";
import type { GlobalChat } from "./global-chat.tsx";
import { typeInPrompt } from "./test-typing.ts";

// A chat's own page, read as its route reads it, against core's chats
// faked at the session: only the address's chat shows there and is asked
// in, whatever selected another chat meanwhile; what is typed for one chat
// never stays for the next; and a read that failed says why, with Try
// again, rather than a chat to ask in.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const identity: Identity = {
  userId: "user-1",
  email: "user-1@acme.test",
  name: "user-1",
  role: "builder",
  teams: [],
  staff: false,
  expiresAt: "2026-11-01T09:00:00.000Z",
};

const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 10);
    await promise;
  });
};

/** Grasp's one chat as the page last drew it. */
const seen: { chat?: GlobalChat } = {};

const Probe = () => {
  const chat = useGlobalChat();
  useEffect(() => {
    seen.chat = chat;
  });
  return null;
};

/** The chat's route as the app names it, which the page under test stands in for. */
const chatRoute = getRouteApi("/_shell/chats/$chatId");

/** The route's page, with the probe beside it. */
const Page = () => {
  const { chatId } = chatRoute.useParams();
  return (
    <>
      <Probe />
      <LoadedChatPage chatId={chatId} page={chatRoute.useLoaderData()} />
    </>
  );
};

const summaryOf = (id: string): ChatSummary => ({
  id,
  title: `Chat ${id}`,
  agentId: "organization",
  createdAt: "2026-11-01T08:00:00.000Z",
  lastAt: "2026-11-01T08:00:00.000Z",
  running: false,
  unread: false,
  make: null,
  archived: false,
});

/**
 * The page at `/chats/<first>`, against a fake core whose summary read
 * ends as `summary` does: its router, to go to another chat's page, and
 * what was asked of core.
 */
const opened = async (
  first: string,
  summary: (id: string) => Promise<ChatSummary> = async (id) =>
    await Promise.resolve(summaryOf(id)),
  /** How core's watch of a chat ends: never, by default. */
  watch: () => Promise<never> = async () =>
    await Promise.withResolvers<never>().promise
) => {
  const asked: string[] = [];
  const chats = {
    models: async () => await Promise.resolve(["openai/gpt-5"]),
    efforts: async () => await Promise.resolve({}),
    list: async () => await Promise.resolve([]),
    agents: async () => await Promise.resolve([]),
    send: async (chatId: string, question: ChatQuestion) => {
      asked.push(`send ${chatId} ${question.text}`);
      await Promise.resolve();
    },
    heldCalls: async () => await Promise.resolve([]),
    watch,
    summary,
  };
  const core = {
    withSession: async <T,>(
      action: (session: { chats: typeof chats }) => Promise<T>
    ): Promise<T> => await action({ chats }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const shell = createRoute({
    getParentRoute: () => rootRoute,
    id: "_shell",
    beforeLoad: () => ({ identity }),
    component: () => (
      <SidebarProvider>
        <GlobalChatProvider>
          <Outlet />
        </GlobalChatProvider>
      </SidebarProvider>
    ),
  });
  const page = createRoute({
    getParentRoute: () => shell,
    path: "/chats/$chatId",
    // As the chat's route reads it (routes/_shell.chats.$chatId.tsx).
    loader: async ({ params: { chatId } }) =>
      await loadFromCore(
        // SAFETY: a stand-in for the parts of core's API the page reads.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        core as never,
        async (session) => await session.chats.summary(chatId)
      ),
    component: () => <Page />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([page])]),
    history: createMemoryHistory({ initialEntries: [`/chats/${first}`] }),
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
  return { asked, router };
};

/** The box to ask in, if the page has one. */
const box = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[role="textbox"]');

const typed = async (text: string): Promise<void> => {
  await act(async () => {
    const into = box();
    if (into === null) {
      throw new Error("No box to ask in");
    }
    typeInPrompt(into, text);
    await Promise.resolve();
  });
};

const sent = async (): Promise<void> => {
  await act(async () => {
    box()?.closest("form")?.requestSubmit();
    await Promise.resolve();
  });
  await settled();
};

/** A button by its name. */
const buttonNamed = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) => wordsOf(each) === name
  );

describe("a chat's own page", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    localStorage.clear();
    sessionStorage.clear();
    setActiveChat(undefined, "chat");
    seen.chat = undefined;
  });

  it("keeps its own chat open and asks only in it when something late selects another", async () => {
    const { asked } = await opened("chat-b");
    const before = activeChat("chat");

    // A read or a send for chat A, answered once B's page is open.
    act(() => {
      setActiveChat("chat-a", "chat");
    });
    await settled();
    await typed("Only for B");
    await sent();

    expect({ before, after: activeChat("chat"), asked }).toStrictEqual({
      before: "chat-b",
      after: "chat-b",
      asked: ["send chat-b Only for B"],
    });
  });

  it("starts the next chat's page with an empty box, nothing typed for the last one", async () => {
    const { router } = await opened("chat-a");
    await typed("Half a thought for A");
    const typedForA = box()?.textContent;

    await act(async () => {
      await router.navigate({
        to: "/chats/$chatId",
        params: { chatId: "chat-b" },
      });
    });
    await settled();

    expect({ typedForA, onB: box()?.textContent }).toStrictEqual({
      typedForA: "Half a thought for A",
      onB: "",
    });
  });

  it("says why a read that failed did, with Try again, and gives no box to ask in", async () => {
    await opened("chat-a", async () => {
      await Promise.resolve();
      throw internalErrors.create("internal.unexpected");
    });

    expect({
      tryAgain: buttonNamed("Try again") !== undefined,
      box: box(),
    }).toStrictEqual({ tryAgain: true, box: null });
  });

  it("is not found for a chat core has none of for the person, with no box to ask in", async () => {
    await opened("chat-gone", async () => {
      await Promise.resolve();
      throw agentErrors.create("agent.chat_not_found");
    });

    expect({
      notFound: document.body.textContent.includes("This page is not here"),
      box: box(),
    }).toStrictEqual({ notFound: true, box: null });
  });

  it("never gives the chat open now a name core took for another one", async () => {
    const { router } = await opened("chat-a");
    // A rename of chat A, answered once B's page is open.
    const renameA = seen.chat?.retitle;
    await act(async () => {
      await router.navigate({
        to: "/chats/$chatId",
        params: { chatId: "chat-b" },
      });
    });
    await settled();
    act(() => {
      renameA?.("chat-a", "Renamed A");
    });
    await settled();

    expect(seen.chat?.summary?.title).toBe("Chat chat-b");
  });

  it("is not found once core has none of its chat any more, and never selects it again", async () => {
    const selected: (string | undefined)[] = [];
    await opened("chat-gone", undefined, async () => {
      await Promise.resolve();
      throw agentErrors.create("agent.chat_not_found");
    });
    // From here on: each chat the frame's chat is made to show.
    const seenNow = activeChat("chat");
    for (let tick = 0; tick < 5; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one moment after another
      await settled();
      selected.push(activeChat("chat"));
    }

    expect({
      notFound: document.body.textContent.includes("This page is not here"),
      box: box(),
      seenNow,
      selected,
    }).toStrictEqual({
      notFound: true,
      box: null,
      seenNow: undefined,
      selected: [undefined, undefined, undefined, undefined, undefined],
    });
  });
});
