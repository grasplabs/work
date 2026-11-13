// @vitest-environment happy-dom
import type { Blueprint } from "@grasp-os/shared/apps";
import type { ChatAgent, ChatMake, ChatQuestion } from "@grasp-os/shared/chat";
import { blueprintIdSchema } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { SidebarProvider } from "@grasp-os/ui/components/sidebar";
import { typeInPrompt } from "@grasp-os/ui/testing";
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

import type { Loaded } from "../load-from-core.tsx";
import { examplesFor } from "../make/examples.ts";
import { activeChat } from "./active-chat.ts";
import { ChatStart } from "./chat-start.tsx";
import type { MakeIdeas } from "./chat-start.tsx";
import { GlobalChatProvider } from "./global-chat.tsx";

// Chat's own page from Make something: ideas to start from in place of the
// questions (an App's blueprints, a workflow's starting sentences), each
// only filling the box, nothing made; the first question makes the chat
// with what to make, which the chat keeps. Core is faked at its session.

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

const blueprint: Blueprint = {
  id: blueprintIdSchema.parse("blueprint-1"),
  name: "Service desk",
  description: "Every client question, until it's solved.",
  app: null,
  version: null,
  markedBy: null,
  markedAt: "2026-10-01T08:00:00.000Z",
  permissions: [],
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

const agent = (id: string, name: string): ChatAgent => ({
  id,
  name,
  face: "",
  job: "",
  model: null,
  own: false,
});

/**
 * Chat's page, from Make something `make` with `ideas`, against a fake
 * core whose person may talk to `agents`; the address naming `named`.
 */
const shown = async (
  make?: ChatMake,
  ideas?: MakeIdeas,
  { agents = [], named }: { agents?: ChatAgent[]; named?: string } = {}
) => {
  const asked: string[] = [];
  const chats = {
    models: async () => await Promise.resolve(["openai/gpt-5"]),
    efforts: async () => await Promise.resolve({}),
    list: async () => await Promise.resolve([]),
    agents: async () => await Promise.resolve(agents),
    create: async (title: string, agentId?: string, made?: ChatMake) => {
      const by = agentId === undefined ? "" : ` with ${agentId}`;
      asked.push(`create ${title} ${JSON.stringify(made ?? null)}${by}`);
      return await Promise.resolve({ id: "chat-1", title });
    },
    send: async (chatId: string, question: ChatQuestion) => {
      asked.push(`send ${chatId} ${question.text}`);
      await Promise.resolve();
    },
    watch: async () => await Promise.withResolvers<never>().promise,
    summary: async () => await Promise.withResolvers<never>().promise,
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
  const read: Promise<Loaded<MakeIdeas>> | undefined =
    ideas === undefined
      ? undefined
      : Promise.resolve({ state: "ready", data: ideas });
  const page = createRoute({
    getParentRoute: () => shell,
    path: "/",
    component: () => <ChatStart agent={named} ideas={read} make={make} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([shell.addChildren([page])]),
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
  return { asked };
};

const box = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>('[role="textbox"]');
  if (found === null) {
    throw new Error("No box to ask in");
  }
  return found;
};

/** The ideas offered: each tile's words. */
const ideas = (): string[] =>
  [
    ...document.querySelectorAll('[aria-label="Ideas to start from"] button'),
  ].map((each) => each.textContent ?? "");

const pick = async (title: string): Promise<void> => {
  const tile = [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Ideas to start from"] button'
    ),
  ].find((each) => each.getAttribute("aria-label") === title);
  await act(async () => {
    tile?.click();
    await Promise.resolve();
  });
  await settled();
};

describe("Chat's page from Make something", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    localStorage.clear();
  });

  it("offers an App's blueprints, each filling the box with a sentence naming it, and makes nothing", async () => {
    const { asked } = await shown(
      { kind: "app", project: "project-1" },
      { kind: "app", blueprints: [blueprint] }
    );
    const offered = ideas();

    await pick("Service desk");

    expect({ offered, box: box().textContent, asked }).toStrictEqual({
      offered: ["Service deskEvery client question, until it's solved."],
      box: "Make an App from the Service desk blueprint: Every client question, until it's solved.",
      asked: [],
    });
  });

  it("offers a workflow a few starting sentences from the business processes, filling the box", async () => {
    const { asked } = await shown(
      { kind: "workflow" },
      { kind: "workflow", examples: examplesFor(["r2r"]) }
    );
    const offered = ideas();

    await pick("Track the month-end close");

    expect({ offered, box: box().textContent, asked }).toStrictEqual({
      offered: [
        "Track the month-end closeRecord-to-Report",
        "Approve big invoicesPurchase-to-Pay",
        "Onboard a new hireHire-to-Retire",
      ],
      box: "Keep track of the month-end close: who does what, and remind people when they're late.",
      asked: [],
    });
  });

  it("makes the chat with what to make, which it keeps, on the first question", async () => {
    const { asked } = await shown({
      kind: "app",
      project: "project-1",
    });

    await act(async () => {
      typeInPrompt(box(), "Track the month-end close");
      await Promise.resolve();
    });
    await act(async () => {
      box().closest("form")?.requestSubmit();
      await Promise.resolve();
    });
    await settled();

    expect({ asked, open: activeChat() }).toStrictEqual({
      asked: [
        'create Track the month-end close {"kind":"app","project":"project-1"}',
        "send chat-1 Track the month-end close",
      ],
      // The chat it made opens, over the page.
      open: "chat-1",
    });
  });

  it("without Make something, asks as ever: no ideas, a chat with nothing to make", async () => {
    const { asked } = await shown();

    await act(async () => {
      typeInPrompt(box(), "What waits on me today?");
      await Promise.resolve();
    });
    await act(async () => {
      box().closest("form")?.requestSubmit();
      await Promise.resolve();
    });
    await settled();

    expect({ ideas: ideas(), asked }).toStrictEqual({
      ideas: [],
      asked: [
        "create What waits on me today? null",
        "send chat-1 What waits on me today?",
      ],
    });
  });

  it("starts the chat with the agent the address names, among those the person may talk to", async () => {
    const { asked } = await shown(undefined, undefined, {
      agents: [agent("organization", "Grasp"), agent("agent-2", "Claire")],
      named: "agent-2",
    });

    await act(async () => {
      typeInPrompt(box(), "Which invoices are late?");
      await Promise.resolve();
    });
    await act(async () => {
      box().closest("form")?.requestSubmit();
      await Promise.resolve();
    });
    await settled();

    expect(asked).toStrictEqual([
      "create Which invoices are late? null with agent-2",
      "send chat-1 Which invoices are late?",
    ]);
  });
});
