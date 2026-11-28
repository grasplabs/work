// @vitest-environment happy-dom

import { agentErrors } from "@grasp-os/shared/agent";
import type {
  ChatQuestion,
  ChatSummary,
  ChatListUpdate,
  ChatMessage,
  ChatUpdate,
} from "@grasp-os/shared/chat";
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
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { loadFromCore } from "../load-from-core.tsx";
import { wordsOf } from "../test-words.ts";
import { activeChat, forgetActiveChats, setActiveChat } from "./active-chat.ts";
import { LoadedChatPage } from "./chat-page.tsx";
import { GlobalChatProvider, useGlobalChat } from "./global-chat.tsx";
import type { GlobalChat } from "./global-chat.tsx";
import { setPending } from "./pending-question.ts";
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
      <LoadedChatPage chatId={chatId} page={chatRoute.useLoaderData().page} />
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
  /** How core's watch of a chat goes: it never ends, and sends nothing by default. */
  watch: (
    chatId: string,
    after: number | null,
    onUpdate: (update: ChatUpdate) => void
  ) => Promise<never> = async () =>
    await Promise.withResolvers<never>().promise,
  /** How core takes a question, once it is asked: at once by default. */
  taking: () => Promise<void> = async () => {
    await Promise.resolve();
  },
  /**
   * How each attaching of a file goes, in turn, before they all go
   * through: a failure throws after core took it, its answer lost.
   */
  attaches: (Error | undefined)[] = []
) => {
  const asked: string[] = [];
  /** The key each attaching of a file went with, in turn. */
  const attachedWith: (string | undefined)[] = [];
  /** The files each question sent names. */
  const named: string[][] = [];
  const chats = {
    models: async () => await Promise.resolve(["openai/gpt-5"]),
    efforts: async () => await Promise.resolve({}),
    watchList: async (onUpdate: (update: ChatListUpdate) => void) => {
      onUpdate({
        chats: [summaryOf(first)],
        removed: [],
        full: true,
        archived: 0,
      });
      return await Promise.withResolvers<never>().promise;
    },
    agents: async () => await Promise.resolve([]),
    attachFile: async (
      _chatId: string,
      file: { name: string },
      key?: string
    ) => {
      attachedWith.push(key);
      const id = `file-${attachedWith.length}`;
      const failure = attaches.shift();
      if (failure !== undefined) {
        throw failure;
      }
      return await Promise.resolve({ id, name: file.name, type: "csv" });
    },
    send: async (chatId: string, question: ChatQuestion) => {
      asked.push(`send ${chatId} ${question.text}`);
      named.push(question.files ?? []);
      await taking();
    },
    heldCalls: async () => await Promise.resolve([]),
    cancel: async (chatId: string) => {
      asked.push(`cancel ${chatId}`);
      return await Promise.resolve({ dropped: ["Germany?"] });
    },
    sendNow: async (chatId: string) => {
      asked.push(`sendNow ${chatId}`);
      await Promise.resolve();
    },
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
    loader: ({ params: { chatId } }) => ({
      page: loadFromCore(
        // SAFETY: a stand-in for the parts of core's API the page reads.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        core as never,
        async (session) => await session.chats.summary(chatId)
      ),
    }),
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
  return { asked, attachedWith, named, router };
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

/** A watch that sends the restricted chat as `now` has it, then holds. */
const restricted =
  (now: Pick<ChatUpdate, "partial" | "held">) =>
  async (
    _chatId: string,
    _after: number | null,
    onUpdate: (update: ChatUpdate) => void
  ): Promise<never> => {
    await Promise.resolve();
    onUpdate({
      messages: [
        {
          id: 1,
          role: "user",
          text: "Which deals closed?",
          at: "2026-11-01T08:00:00.000Z",
        },
      ],
      running: true,
      stopped: null,
      worked: 0,
      provenance: { sources: ["conn-1"], restricted: true },
      ...now,
    });
    return await Promise.withResolvers<never>().promise;
  };

/**
 * A watch that sends the chat as an answer is written, a question queued
 * behind it, then holds.
 */
/** Each row of the thread holding `words`, as it reads. */
const drawn = (words = "Spain?") =>
  [...document.querySelectorAll("article")]
    .filter((row) => row.textContent.includes(words))
    .map((row) => wordsOf(row));

/** Grasp answering France?, with `queued` behind it, as core sends it. */
const answering = (queued: { id: string; text: string }[]): ChatUpdate => ({
  messages: [
    {
      id: 1,
      role: "user",
      text: "France?",
      at: "2026-11-01T08:00:00.000Z",
    },
  ],
  partial: {
    from: 0,
    text: "Paris",
    code: [],
    tools: [],
    reasoning: { from: 0, text: "" },
  },
  running: true,
  queued,
  stopped: null,
  held: 0,
  worked: 0,
  provenance: { sources: [], restricted: false },
});

const answeringWithQueued = async (
  _chatId: string,
  _after: number | null,
  onUpdate: (update: ChatUpdate) => void
): Promise<never> => {
  await Promise.resolve();
  onUpdate({
    messages: [
      {
        id: 1,
        role: "user",
        text: "France?",
        at: "2026-11-01T08:00:00.000Z",
      },
    ],
    partial: {
      from: 0,
      text: "Paris",
      code: [],
      tools: [],
      reasoning: { from: 0, text: "" },
    },
    running: true,
    queued: [{ id: "7", text: "Germany?" }],
    stopped: null,
    held: 0,
    worked: 0,
    provenance: { sources: [], restricted: false },
  });
  return await Promise.withResolvers<never>().promise;
};

/** A button by its accessible name, its words or its label. */
const buttonLabelled = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (each) => each.getAttribute("aria-label") === name || wordsOf(each) === name
  );

/** Whether the page says the chat is restricted. */
const saysRestricted = () =>
  [...document.querySelectorAll('[data-slot="badge"]')].some(
    (badge) => wordsOf(badge) === "Restricted"
  );

/** A question or an answer of a chat, by its ID. */
const message = (id: number, role: "user" | "assistant"): ChatMessage =>
  role === "user"
    ? { id, role, text: `Question ${id}`, at: "2026-11-01T08:00:00.000Z" }
    : {
        id,
        role,
        text: `Answer ${id}`,
        code: [],
        tools: [],
        end: "done",
        at: "2026-11-01T08:01:00.000Z",
      };

/** Whether the page shows the thread's skeleton, and which questions it shows. */
const shows = () => ({
  skeleton: document.querySelector('[data-slot="message-skeleton"]') !== null,
  questions: ["Question 1", "Question 3"].filter((words) =>
    document.body.textContent.includes(words)
  ),
});

describe("a chat's own page", () => {
  // The thread's code (Markdown, maths, highlighting) loads once a chat is
  // shown (chat-body.tsx), and its first load in a test worker takes
  // seconds, far longer on a loaded runner: past a test's 5 s, which then
  // leaves its act() running into the tests after it. Loaded once here,
  // its own time, so each test only draws it.
  beforeAll(async () => {
    await import("./thread.tsx");
  }, 60_000);

  afterEach(async () => {
    act(() => {
      root?.unmount();
    });
    // Its chat's watch stops a moment after.
    await settled();
    root = undefined;
    document.body.replaceChildren();
    localStorage.clear();
    sessionStorage.clear();
    // What the tab kept of chats is the person's: none for the next test.
    forgetActiveChats();
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

  it("shows a question in the thread the moment it is sent, and puts it back in the box with why once core refuses it, before what was typed since", async () => {
    const taken = Promise.withResolvers<undefined>();
    await opened(
      "chat-a",
      undefined,
      async (_chatId, _after, onUpdate) => {
        await Promise.resolve();
        onUpdate({
          messages: [
            {
              id: 1,
              role: "user",
              text: "Which deals closed?",
              at: "2026-11-01T08:00:00.000Z",
            },
          ],
          partial: null,
          running: false,
          stopped: null,
          held: 0,
          worked: 0,
        });
        return await Promise.withResolvers<never>().promise;
      },
      async () => {
        await taken.promise;
      }
    );
    await typed("And which are late?");
    await sent();
    // The thread, drawn once a chat is shown.
    await vi.waitFor(async () => {
      await settled();
      expect(document.querySelector("article")).not.toBeNull();
    });
    const meanwhile = {
      box: box()?.textContent,
      thread: [...document.querySelectorAll("article")].map((row) =>
        wordsOf(row)
      ),
    };
    await typed("Only this month");
    await act(async () => {
      taken.reject(agentErrors.create("agent.invalid_question"));
      await taken.promise.catch(() => {});
    });
    await settled();

    expect({
      meanwhile,
      box: box()?.textContent,
      thread: document.body.textContent.split("And which are late?").length - 1,
      notes: [
        ...document.querySelectorAll('[data-slot="prompt-input-note"]'),
      ].map((note) => note.textContent),
    }).toStrictEqual({
      meanwhile: {
        box: "",
        thread: [
          expect.stringContaining("Which deals closed?"),
          expect.stringContaining("And which are late?"),
        ],
      },
      box: "And which are late?\n\nOnly this month",
      thread: 1,
      notes: [
        "Could not send. Your message is kept.",
        agentErrors.create("agent.invalid_question").message,
      ],
    });
  });

  it("attaches a file again with the key it went with on the next connection when the one it went on broke mid-upload, and the question names it once", async () => {
    const { asked, attachedWith, named } = await opened(
      "chat-files",
      undefined,
      undefined,
      undefined,
      // Core took it; the socket broke before its answer came back.
      [new Error("Peer closed WebSocket: 1006")]
    );
    await act(async () => {
      seen.chat?.composer.onAttach?.([new File(["a,b"], "rows.csv")]);
      await Promise.resolve();
    });
    await typed("What do these rows say?");

    await sent();

    const [key] = attachedWith;
    expect({
      keys: attachedWith,
      asked,
      named,
    }).toStrictEqual({
      // The same both times, so core, which keeps the file under its key,
      // attaches it once.
      keys: [expect.stringMatching(/^[\da-f-]{36}$/u), key],
      asked: ["send chat-files What do these rows say?"],
      named: [["file-2"]],
    });
  });

  it("takes back a chat's refused question with its own files alone, none of the chat it came from", async () => {
    const { router } = await opened("chat-a");
    await act(async () => {
      seen.chat?.composer.onAttach?.([new File(["a"], "from-a.csv")]);
      await Promise.resolve();
    });
    setPending("chat-b", {
      text: "And B?",
      mentions: [],
      files: [{ id: "file-b", file: new File(["b"], "for-b.csv") }],
      at: "2026-11-01T08:00:00.000Z",
      queues: false,
      alreadyQueued: 0,
      key: "key-b",
      owner: "a box no longer here",
      fromBox: true,
      state: { failed: "Refused." },
    });

    await act(async () => {
      await router.navigate({
        to: "/chats/$chatId",
        params: { chatId: "chat-b" },
      });
    });
    await settled();

    expect({
      box: box()?.textContent,
      files: seen.chat?.composer.files.map(({ name }) => name),
    }).toStrictEqual({ box: "And B?", files: ["for-b.csv"] });
  });

  it("shows the chat to ask in at once, its name as the person's list has it, while core's read of it is still on its way", async () => {
    await opened(
      "chat-a",
      async () => await Promise.withResolvers<never>().promise
    );

    expect({
      box: box() !== null,
      named: document.body.textContent.includes("Chat chat-a"),
    }).toStrictEqual({ box: true, named: true });
  });

  it("shows a chat it showed before at once on coming back, never its skeleton, then as core has it now, and forgets it once the person signs out", async () => {
    // Chat A's first watch sends two messages at once; the second waits
    // until the test lets it go, then sends four; any after, nothing.
    let opens = 0;
    const later = Promise.withResolvers<boolean>();
    const { router } = await opened(
      "chat-a",
      undefined,
      async (chatId, _after, onUpdate) => {
        if (chatId === "chat-a") {
          opens += 1;
          const first = opens === 1;
          await (first ? Promise.resolve() : later.promise);
          if (opens > 2) {
            return await Promise.withResolvers<never>().promise;
          }
          onUpdate({
            messages: first
              ? [message(1, "user"), message(2, "assistant")]
              : [1, 2, 3, 4].map((id) =>
                  message(id, id % 2 === 1 ? "user" : "assistant")
                ),
            partial: null,
            running: false,
            stopped: null,
            held: 0,
            worked: 0,
            seenUpTo: 2,
          });
        }
        return await Promise.withResolvers<never>().promise;
      }
    );
    const go = async (chatId: string) => {
      await act(async () => {
        await router.navigate({ to: "/chats/$chatId", params: { chatId } });
      });
      await settled();
    };
    // Shown once its thread is drawn.
    await vi.waitFor(() => {
      expect(shows().questions).toStrictEqual(["Question 1"]);
    });
    await go("chat-b");
    await go("chat-a");
    const back = shows();
    await act(async () => {
      later.resolve(true);
      await later.promise;
    });
    await settled();
    const now = shows();
    await go("chat-b");
    act(() => {
      forgetActiveChats();
    });
    await go("chat-a");

    expect({ back, now, signedOut: shows() }).toStrictEqual({
      back: { skeleton: false, questions: ["Question 1"] },
      now: { skeleton: false, questions: ["Question 1", "Question 3"] },
      signedOut: { skeleton: true, questions: [] },
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

  it("says a restricted chat is restricted over the box while an answer is written, and while a held write waits on the person", async () => {
    // Chats of their own: each page follows its chat from its own watch.
    await opened(
      "chat-writing",
      undefined,
      restricted({
        partial: {
          from: 0,
          text: "Three closed",
          code: [],
          tools: [],
          reasoning: { from: 0, text: "" },
        },
        held: 0,
      })
    );
    await settled();
    const writing = saysRestricted();
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await opened(
      "chat-held",
      undefined,
      restricted({ partial: null, held: 1 })
    );
    await settled();

    expect({ writing, held: saysRestricted() }).toStrictEqual({
      writing: true,
      held: true,
    });
  });

  it("takes a question while the answer is written, Stop standing beside Send", async () => {
    const { asked } = await opened("chat-a", undefined, answeringWithQueued);
    await settled();
    const stopAtRest = buttonLabelled("Stop") !== undefined;
    await typed("Spain?");
    const stopBeside = buttonLabelled("Stop") !== undefined;
    await sent();

    expect({ stopAtRest, stopBeside, asked }).toStrictEqual({
      stopAtRest: true,
      stopBeside: true,
      asked: ["send chat-a Spain?"],
    });
  });

  it("gives the text the focus when the keys press the Stop beside Send, which goes as the answer stops", async () => {
    await opened("chat-a", undefined, answeringWithQueued);
    await settled();
    await typed("Spain?");
    const stop = buttonLabelled("Stop");
    act(() => {
      stop?.focus();
      // As the keys press it: a click with no pointer count (`detail` 0).
      stop?.click();
    });
    await settled();

    expect(document.activeElement).toBe(box());
  });

  it("draws a question sent while the answer is written once, as queued, before and after core queues it", async () => {
    const taken = Promise.withResolvers<boolean>();
    let update: ((next: ChatUpdate) => void) | undefined;
    await opened(
      "chat-a",
      undefined,
      async (_chatId, _after, onUpdate) => {
        await Promise.resolve();
        update = onUpdate;
        onUpdate(answering([]));
        return await Promise.withResolvers<never>().promise;
      },
      async () => {
        await taken.promise;
      }
    );
    await settled();
    await typed("Spain?");
    await sent();
    // The thread, drawn once a chat is shown.
    await vi.waitFor(async () => {
      await settled();
      expect(document.body.textContent).toContain("Spain?");
    });
    const onItsWay = drawn();
    await act(async () => {
      update?.(answering([{ id: "8", text: "Spain?" }]));
      taken.resolve(true);
      await taken.promise;
    });
    await settled();

    expect({ onItsWay, queuedByCore: drawn() }).toStrictEqual({
      onItsWay: [expect.stringContaining("Queued")],
      queuedByCore: [expect.stringContaining("Queued")],
    });
  });

  it("puts the questions Stop dropped back in an empty box", async () => {
    const { asked } = await opened("chat-a", undefined, answeringWithQueued);
    await settled();
    act(() => {
      buttonLabelled("Stop")?.click();
    });
    await settled();

    expect({ asked, box: box()?.textContent }).toStrictEqual({
      asked: ["cancel chat-a"],
      box: "Germany?",
    });
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
