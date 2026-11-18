// @vitest-environment happy-dom
import type { Blueprint } from "@grasp-os/shared/apps";
import type { ChatAgent, ChatMake, ChatQuestion } from "@grasp-os/shared/chat";
import { blueprintIdSchema } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { SidebarProvider } from "@grasp-os/ui/components/sidebar";
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
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { CoreReach } from "../core-connection.ts";
import type { Loaded } from "../load-from-core.tsx";
import { examplesFor } from "../make/examples.ts";
import { activeChat } from "./active-chat.ts";
import { ChatStart } from "./chat-start.tsx";
import type { MakeIdeas } from "./chat-start.tsx";
import { GlobalChatProvider } from "./global-chat.tsx";
import { sendDeadlineMs } from "./use-ask.ts";

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
});

/**
 * Chat's page, from Make something `make` with `ideas`, against a fake
 * core whose person may talk to `agents`; the address naming `named`.
 */
const shown = async (
  make?: ChatMake,
  ideas?: MakeIdeas,
  {
    agents = [],
    named,
    models = Promise.resolve(["openai/gpt-5"]),
    confirmed = Promise.resolve(true),
    reach,
  }: {
    agents?: ChatAgent[];
    named?: string;
    /** What core answers asking for the models, once it does. */
    models?: Promise<string[]>;
    /** When core confirms a question sent. */
    confirmed?: Promise<unknown>;
    /** Whether the tab's connection reaches core, as it says and changes it. */
    reach?: { now: CoreReach; changed: Set<() => void> };
  } = {}
) => {
  const asked: string[] = [];
  const chats = {
    models: async () => await models,
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
      await confirmed;
    },
    watch: async () => await Promise.withResolvers<never>().promise,
    summary: async () => await Promise.withResolvers<never>().promise,
  };
  const core = {
    withSession: async <T,>(
      action: (session: { chats: typeof chats }) => Promise<T>
    ): Promise<T> => await action({ chats }),
    ...(reach === undefined
      ? {}
      : {
          get reach(): CoreReach {
            return reach.now;
          },
          watchReach: (changed: () => void) => {
            reach.changed.add(changed);
            return () => {
              reach.changed.delete(changed);
            };
          },
        }),
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
  return { asked, router };
};

const box = (): HTMLTextAreaElement => {
  const found = document.querySelector("textarea");
  if (found === null) {
    throw new Error("No box to ask in");
  }
  return found;
};

/** Types `text` in the box as a person does: its value, then the input event React listens for. */
const typeIn = (into: HTMLTextAreaElement, text: string): void => {
  // Through the prototype's setter, as typing sets it, so React sees the change.
  Reflect.set(
    HTMLTextAreaElement.prototype,
    "value",
    `${into.value}${text}`,
    into
  );
  into.dispatchEvent(new Event("input", { bubbles: true }));
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

/** Presses `element` as a pointer does. */
const pressOn = async (element: Element | undefined): Promise<void> => {
  if (!(element instanceof HTMLElement)) {
    throw new TypeError(
      `Nothing to press among: ${[...document.querySelectorAll("[role]")].map((each) => `${each.getAttribute("role")}:${each.textContent.trim().slice(0, 20)}`).join(" | ")}`
    );
  }
  await act(async () => {
    element.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 })
    );
    element.click();
    await Promise.resolve();
  });
  await settled();
};
/** A menu row or option by the words it starts with. */
const byWords = (words: string): Element | undefined =>
  [...document.querySelectorAll('[role^="menuitem"], [role="option"]')].find(
    (each) => each.textContent.includes(words)
  );

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

    expect({ offered, box: box().value, asked }).toStrictEqual({
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

    expect({ offered, box: box().value, asked }).toStrictEqual({
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
      typeIn(box(), "Track the month-end close");
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
      typeIn(box(), "What waits on me today?");
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

  it("sends a question asked before core has said which models there are once it has, with no second press", async () => {
    const models = Promise.withResolvers<string[]>();
    const { asked } = await shown(undefined, undefined, {
      models: models.promise,
    });
    await act(async () => {
      typeIn(box(), "What waits on me today?");
      await Promise.resolve();
    });

    await act(async () => {
      box().closest("form")?.requestSubmit();
      await Promise.resolve();
    });
    await settled();
    const early = { asked: [...asked], kept: box().value };
    await act(async () => {
      models.resolve(["openai/gpt-5"]);
      await Promise.resolve();
    });
    await settled();

    expect({ early, asked }).toStrictEqual({
      early: { asked: [], kept: "What waits on me today?" },
      asked: [
        "create What waits on me today? null",
        "send chat-1 What waits on me today?",
      ],
    });
  });

  it("says a question waits while Grasp is out of reach, and no more once it went", async () => {
    const confirmed = Promise.withResolvers<boolean>();
    const reach: { now: CoreReach; changed: Set<() => void> } = {
      now: "unreachable",
      changed: new Set(),
    };
    await shown(undefined, undefined, { confirmed: confirmed.promise, reach });
    await act(async () => {
      typeIn(box(), "What waits on me today?");
      await Promise.resolve();
    });

    await act(async () => {
      box().closest("form")?.requestSubmit();
      await Promise.resolve();
    });
    await settled();
    const waiting = document.body.textContent?.includes("Waiting to send.");
    await act(async () => {
      reach.now = "reachable";
      for (const changed of reach.changed) {
        changed();
      }
      confirmed.resolve(true);
      await Promise.resolve();
    });
    await settled();

    expect({
      waiting,
      after: document.body.textContent?.includes("Waiting to send."),
    }).toStrictEqual({ waiting: true, after: false });
  });

  it("says a question waits while the browser is offline, before the connection notices", async () => {
    const confirmed = Promise.withResolvers<boolean>();
    await shown(undefined, undefined, { confirmed: confirmed.promise });
    await act(async () => {
      typeIn(box(), "What waits on me today?");
      await Promise.resolve();
    });
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    });

    await act(async () => {
      window.dispatchEvent(new Event("offline"));
      box().closest("form")?.requestSubmit();
      await Promise.resolve();
    });
    await settled();
    const waiting = document.body.textContent?.includes("Waiting to send.");
    Reflect.deleteProperty(navigator, "onLine");
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      confirmed.resolve(true);
      await Promise.resolve();
    });
    await settled();

    expect(waiting).toBeTruthy();
  });

  it("says in its own words that a question the connection dropped wasn't sent, never the connection's, and keeps it", async () => {
    const raw = "WebSocket closed with code 1006";
    const dropped = Promise.reject(new Error(raw));
    // Awaited only when the question goes.
    dropped.catch(() => {});
    await shown(undefined, undefined, { confirmed: dropped });
    await act(async () => {
      typeIn(box(), "What waits on me today?");
      await Promise.resolve();
    });

    await act(async () => {
      box().closest("form")?.requestSubmit();
      await Promise.resolve();
    });
    await settled();

    const said = document.body.textContent ?? "";
    expect({
      ours: said.includes(
        "Grasp couldn't be reached, so your question wasn't sent."
      ),
      raw: said.includes(raw),
      kept: box().value,
    }).toStrictEqual({
      ours: true,
      raw: false,
      kept: "What waits on me today?",
    });
  });

  it("says a question core doesn't confirm in time wasn't sent, keeps it, sends it once, and goes on when core confirms late", async () => {
    const confirmed = Promise.withResolvers<boolean>();
    const { asked, router } = await shown(undefined, undefined, {
      confirmed: confirmed.promise,
    });
    const send = async (): Promise<void> => {
      await act(async () => {
        box().closest("form")?.requestSubmit();
        await Promise.resolve();
      });
    };
    await act(async () => {
      typeIn(box(), "What waits on me today?");
      await Promise.resolve();
    });
    vi.useFakeTimers();
    try {
      await send();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(sendDeadlineMs);
      });
      const late = {
        said: document.body.textContent.includes(
          "Grasp hasn't confirmed your question yet."
        ),
        failed: document.body.textContent.includes("Could not send"),
        kept: box().value,
      };
      // Send again while core is late: still the one question.
      await send();
      const sentOnce = [...asked];
      await act(async () => {
        confirmed.resolve(true);
        await vi.advanceTimersByTimeAsync(0);
      });

      expect({
        late,
        sentOnce,
        // Confirmed late, it is asked: the person is on the chat's page.
        at: router.state.location.pathname,
      }).toStrictEqual({
        late: {
          said: true,
          failed: true,
          kept: "What waits on me today?",
        },
        sentOnce: [
          "create What waits on me today? null",
          "send chat-1 What waits on me today?",
        ],
        at: "/chats/chat-1",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the chat with the agent the address names, among those the person may talk to", async () => {
    const { asked } = await shown(undefined, undefined, {
      agents: [agent("organization", "Grasp"), agent("agent-2", "Claire")],
      named: "agent-2",
    });

    await act(async () => {
      typeIn(box(), "Which invoices are late?");
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

  it("starts the chat with the agent chosen in the box's plus menu, the company's first until then", async () => {
    const { asked } = await shown(undefined, undefined, {
      agents: [agent("organization", "Grasp"), agent("agent-2", "Claire")],
    });
    await pressOn(
      // The plus, by the part's own English name (no catalogue here).
      document.querySelector('[aria-label="Add to message"]') ?? undefined
    );
    await pressOn(byWords("Agent"));
    await pressOn(byWords("Claire"));
    await act(async () => {
      typeIn(box(), "Which invoices are late?");
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
