// @vitest-environment happy-dom
import type {
  ChatBuild,
  ChatMessage,
  ChatPlanned,
  ChatToolEvent,
} from "@grasp-os/shared/chat";
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

import { activeChat } from "./active-chat.ts";
import { answersText } from "./asked-questions.tsx";
import { slotOf } from "./chat-subject.ts";
import { ChatThread } from "./thread.tsx";

// Making something in a chat's thread: the plan the agent proposes, as a
// card whose Build it waits for every connection it needs (core's own
// list, read again as the window comes back), builds the plan, nothing
// more, and lands the person on what it made with this chat as its chat;
// after Build it, the agent's steps under "Show details", a step it
// recovered from never a failure. The person's answers to the agent's
// questions read as questions and answers. Core is faked at its session;
// the thread is the real one.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const at = (minute: number): string =>
  `2026-11-11T09:${String(minute).padStart(2, "0")}:00.000Z`;

const plan: ChatPlanned = {
  callId: "call-plan",
  parts: [
    {
      kind: "workflow",
      name: "Late reminder",
      does: "Mails whoever is late.",
      needs: [{ source: "native", provider: "microsoft", name: "Outlook" }],
    },
    { kind: "app", name: "Month-end close", does: "Every close task." },
  ],
  who: "Finance team",
};

const said = (
  id: number,
  minute: number,
  text: string,
  more: Partial<Extract<ChatMessage, { role: "user" }>> = {}
): ChatMessage => ({ id, role: "user", text, at: at(minute), ...more });

const reply = (
  id: number,
  minute: number,
  more: Partial<Extract<ChatMessage, { role: "assistant" }>> = {}
): ChatMessage => ({
  id,
  role: "assistant",
  text: "",
  citations: [],
  code: [],
  tools: [],
  end: "done",
  at: at(minute),
  ...more,
});

const result = (
  id: number,
  minute: number,
  callId: string,
  failed: boolean
): ChatMessage => ({
  id,
  role: "result",
  callId,
  text: failed ? "It doesn't compile." : "Saved.",
  failed,
  at: at(minute),
});

/** The agent's write of the App's page, by its call. */
const write = (callId: string) => ({
  callId,
  tool: "writeFile",
  codeBefore: 0,
  input: { app: "app-1", files: { "src/routes/index.tsx": "…" } },
});

/** The plan's App alone. */
const appOnly: ChatPlanned = {
  ...plan,
  parts: plan.parts.filter(({ kind }) => kind === "app"),
};

/** Core's side of the thread: the person's connections, and Build it. */
const fakeCore = (connected: { current: boolean }) => {
  const built: ChatBuild[] = [];
  const session = {
    connections: {
      list: async () =>
        await Promise.resolve(
          connected.current
            ? [{ source: "native", provider: "microsoft", status: "active" }]
            : []
        ),
    },
    chats: {
      build: async (_chat: string, build: ChatBuild) => {
        built.push(build);
        return await Promise.resolve({
          app: { id: "app-1", name: "Month-end close" },
        });
      },
    },
  };
  return {
    built,
    core: {
      withSession: async <T,>(
        action: (given: typeof session) => Promise<T>
      ): Promise<T> => await action(session),
    },
  };
};

/** The thread of `messages`, which can build, on a page of its own. */
const thread = async (
  messages: readonly ChatMessage[],
  {
    running = false,
    tools = [],
    connected = { current: true },
  }: {
    running?: boolean;
    tools?: ChatToolEvent[];
    connected?: { current: boolean };
  } = {}
) => {
  const { core, built } = fakeCore(connected);
  const page = createRootRoute({
    component: () => (
      <ChatThread
        build={{
          model: "openai/gpt-5",
          effort: undefined,
          onChangePlan: () => {
            // The box is the panel's.
          },
        }}
        chatId="chat-1"
        loaded
        messages={messages}
        onRetry={() => {
          // Not asked again here.
        }}
        output={null}
        partial={null}
        running={running}
        tools={tools}
      />
    ),
  });
  const router = createRouter({
    routeTree: page,
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
    await Promise.resolve();
  });
  return { built, router };
};

const button = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === name
  );

const settle = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

describe("making something in a chat's thread", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("shows the plan's parts and what they still need, and builds it once the connection is there, nothing else", async () => {
    const connected = { current: false };
    const { built, router } = await thread(
      [
        said(1, 0, "Keep track of the month-end close."),
        reply(2, 1, { planned: plan }),
      ],
      { connected }
    );
    await settle();
    const card = document.querySelector(
      'section[aria-label="Here\'s what Grasp will make"]'
    );
    const shown = {
      parts: [...(card?.querySelectorAll("li") ?? [])].map(
        (each) => each.textContent
      ),
      connect: decodeURIComponent(
        card
          ?.querySelector<HTMLAnchorElement>('a[href^="/integrations"]')
          ?.getAttribute("href") ?? ""
      ),
      off: button("Build it")?.disabled,
    };
    connected.current = true;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await settle();
    const on = button("Build it")?.disabled === false;
    await act(async () => {
      button("Build it")?.click();
      await Promise.resolve();
    });
    await settle();

    expect({
      shown,
      on,
      built,
      // Landed on the App it made, this chat its chat there.
      at: router.state.location.pathname,
      docked: activeChat(slotOf({ kind: "app", id: "app-1" })),
    }).toStrictEqual({
      shown: {
        parts: [
          "A page your team opensMonth-end closeEvery close task.",
          "Runs on its ownLate reminderMails whoever is late.Needs Outlook connectedConnect",
          "Who gets itFinance teamOnly you see it while you try it. You share it when it's right.",
        ],
        connect: "/integrations/native:microsoft",
        off: true,
      },
      on: true,
      built: [{ plan: "call-plan", text: "Build it", model: "openai/gpt-5" }],
      at: "/apps/app-1",
      docked: "chat-1",
    });
  });

  it("after Build it, shows the agent's work as any turn, a retried step no failure", async () => {
    const builtBy = {
      plan: "call-plan",
      app: { id: "app-1", name: "Month-end close" },
    };
    await thread([
      said(1, 0, "Keep track of the month-end close."),
      reply(2, 1, { planned: appOnly }),
      said(3, 2, "Build it", { built: builtBy }),
      reply(4, 3, { tools: [write("call-1")] }),
      result(5, 3, "call-1", true),
      reply(6, 4, { tools: [write("call-2")] }),
      result(7, 4, "call-2", false),
      reply(8, 5, { text: "It's ready to try." }),
    ]);
    const shown = document.body.textContent ?? "";

    expect({
      retried: shown.includes("Retried"),
      failed: shown.includes("Failed"),
      said: shown.includes("It's ready to try."),
    }).toStrictEqual({
      retried: true,
      failed: false,
      said: true,
    });
  });

  it("shows the person's answers to the agent's questions as each question and its answer", async () => {
    const asked = {
      callId: "call-ask",
      questions: [
        {
          kind: "choice" as const,
          question: "How should the tasks be set up?",
          options: [{ label: "Reusable checklist" }, { label: "One-off" }],
        },
        {
          kind: "choice" as const,
          question: "When should reminders go out?",
          options: [{ label: "Every Friday" }, { label: "Every morning" }],
        },
      ],
    };
    await thread([
      said(1, 0, "Keep track of the month-end close."),
      reply(2, 1, { asked }),
      said(3, 2, answersText(asked, [{ picked: [0] }, { picked: [0] }])),
    ]);

    expect(
      [...document.querySelectorAll("dl > div")].map((pair) => ({
        question: pair.querySelector("dt")?.textContent,
        answer: pair.querySelector("dd")?.textContent,
      }))
    ).toStrictEqual([
      {
        question: "How should the tasks be set up?",
        answer: "Reusable checklist",
      },
      { question: "When should reminders go out?", answer: "Every Friday" },
    ]);
  });
});
