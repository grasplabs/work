// @vitest-environment happy-dom
import type { ThinkingGround } from "@grasp-os/shared/brain";
import type {
  ChatMessage,
  ChatPartial,
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
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ChatThread } from "./thread.tsx";

// An answer's steps as one trace in the thread. What the model thought:
// while it thinks, its words stream in, open under "Thinking"; once the
// answer is kept, a quiet line says how long it thought, folded, and opens
// to what it thought. How long Grasp worked is the trace's first line. And
// what an answer's code did to the dashboard, under the step that did it.
// While an answer is written, the words of the block being written fade
// in where they land, the blocks before it done; a kept one stands still.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** The memories the page undid, by id, in order. */
const forgotten: string[] = [];

const asked: ChatMessage = {
  id: 1,
  role: "user",
  text: "What is 2 + 2?",
  at: "2026-10-27T09:00:00.000Z",
};

/**
 * The thread of `messages`, with `partial` being written while it runs,
 * and the calls its code made (`tools`), on a page of its own.
 */
const thread = async (
  messages: readonly ChatMessage[],
  partial: ChatPartial | null = null,
  tools: readonly ChatToolEvent[] = [],
  /** What core says a picture of thinking is drawn from; it can't be read without. */
  ground?: ThinkingGround,
  /** Whether the turn runs on past its answer, checking its drafts. */
  checking?: boolean
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      action: (session: {
        brain: { thinking: () => Promise<ThinkingGround> };
        brainMemories: { forget: (memory: string) => Promise<"done"> };
      }) => Promise<T>
    ): Promise<T> =>
      await action({
        brainMemories: {
          forget: async (memory) => {
            await Promise.resolve();
            forgotten.push(memory);
            return "done";
          },
        },
        brain: {
          thinking: async () => {
            await Promise.resolve();
            if (ground === undefined) {
              throw new Error("Core can't be reached.");
            }
            return ground;
          },
        },
      }),
  };
  const page = createRootRoute({
    component: () => (
      <ChatThread
        chatId="chat"
        loaded
        messages={messages}
        onRetry={() => {
          // Not asked again here.
        }}
        output={null}
        partial={partial}
        running={partial !== null || checking !== undefined}
        checking={checking}
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
};

/** The first step that folds open: its line, whether it is open, and what it shows. */
const firstStep = () => {
  const line = document.querySelector("button[aria-expanded]");
  const shows = line?.getAttribute("aria-controls");
  return {
    line: line?.textContent,
    open: line?.getAttribute("aria-expanded") === "true",
    shows:
      shows === null || shows === undefined
        ? undefined
        : document.querySelector(`#${shows}`)?.textContent,
  };
};

/** What the thread's live status line says now. */
const status = () => document.querySelector("output")?.textContent;

/** The way to the brain under an answer, if there is one. */
const findWay = () =>
  document.querySelector<HTMLAnchorElement>('a[href^="/brain"]');

/** The way to the brain under an answer, once whatever comes has come. */
const wayToBrain = async () => {
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    expect(findWay()).not.toBeNull();
  });
  const way = findWay();
  return {
    href: way?.getAttribute("href"),
    text: way?.textContent,
    picture: way?.querySelector("svg") !== null,
  };
};

describe(ChatThread, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    forgotten.length = 0;
  });

  it("says under a call of remember that it is an instruction, with the value it holds", async () => {
    const at = "2026-10-27T09:00:05.000Z";
    await thread([
      asked,
      {
        id: 2,
        role: "assistant",
        text: "",
        citations: [],
        code: [],
        tools: [
          {
            callId: "remember",
            tool: "remember",
            codeBefore: 0,
            input: { statement: "Answer in Dutch" },
          },
        ],
        end: "done",
        at,
      },
      {
        id: 3,
        role: "result",
        callId: "remember",
        text: "Saved.",
        failed: false,
        at,
        saved: {
          memory: "3f1c4a8e-5d6b-4c2a-9e7f-1a2b3c4d5e6f",
          type: "instruction",
          statement: "Always answer in Dutch",
          value: "Dutch",
        },
      },
    ]);
    const text = document.body.textContent;

    expect({
      kind: text.includes("Instruction"),
      saved: text.includes(
        "Grasp will remember: Always answer in Dutch (value: Dutch)"
      ),
    }).toStrictEqual({ kind: true, saved: true });
  });

  it("says under a call of remember who or what it is about, when it isn't the person", async () => {
    const at = "2026-10-27T09:00:05.000Z";
    await thread([
      asked,
      {
        id: 2,
        role: "assistant",
        text: "",
        citations: [],
        code: [],
        tools: [
          {
            callId: "remember",
            tool: "remember",
            codeBefore: 0,
            input: { statement: "Prefers answers by mail" },
          },
        ],
        end: "done",
        at,
      },
      {
        id: 3,
        role: "result",
        callId: "remember",
        text: "Saved.",
        failed: false,
        at,
        saved: {
          memory: "3f1c4a8e-5d6b-4c2a-9e7f-1a2b3c4d5e6f",
          type: "fact",
          statement: "Prefers answers by mail",
          about: "Bob",
        },
      },
    ]);

    expect(document.body.textContent).toContain(
      "Grasp will remember about Bob: Prefers answers by mail"
    );
  });

  it("says under a call of remember what Grasp will remember, in the person's words, and undoes it there", async () => {
    const at = "2026-10-27T09:00:05.000Z";
    const memory = "3f1c4a8e-5d6b-4c2a-9e7f-1a2b3c4d5e6f";
    await thread([
      asked,
      {
        id: 2,
        role: "assistant",
        text: "",
        citations: [],
        code: [],
        tools: [
          {
            callId: "remember",
            tool: "remember",
            codeBefore: 0,
            input: { statement: "Acme renews on 1 March" },
          },
        ],
        end: "done",
        at,
      },
      {
        id: 3,
        role: "result",
        callId: "remember",
        text: "Saved.",
        failed: false,
        at,
        saved: { memory, type: "fact", statement: "Acme renews on 1 March" },
      },
    ]);
    const shown = document.body.textContent;
    const undo = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Undo"
    );
    await act(async () => {
      undo?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain(
        "Grasp no longer remembers this."
      );
    });

    expect({
      line: shown.includes("Saved to your memory"),
      notice: shown.includes("Grasp will remember: Acme renews on 1 March"),
      forgotten,
      undoLeft: [...document.querySelectorAll("button")].some(
        (button) => button.textContent === "Undo"
      ),
    }).toStrictEqual({
      line: true,
      notice: true,
      forgotten: [memory],
      undoLeft: false,
    });
  });

  it("streams what the model thinks, open under Thinking, before it says a word", async () => {
    await thread([asked], {
      text: "",
      code: [],
      tools: [],
      reasoning: "Add two to two.",
    });

    expect(firstStep()).toStrictEqual({
      line: "Thinking",
      open: true,
      shows: "Add two to two.",
    });
  });

  it("says it checks the App while its turn checks the drafts it wrote, past its answer", async () => {
    const answered: ChatMessage[] = [
      asked,
      {
        id: 2,
        role: "assistant",
        text: "The desk is written.",
        citations: [],
        code: [],
        tools: [],
        end: "done",
        at: "2026-10-27T09:00:05.000Z",
      },
    ];
    await thread(answered, null, [], undefined, true);
    const checking = status();
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    // Running on without a check: what it does otherwise.
    await thread(answered, null, [], undefined, false);

    expect({ checking, otherwise: status() }).toStrictEqual({
      checking: "Checking the App…",
      otherwise: "Thinking",
    });
  });

  it("says over a kept answer how long the model thought, and unfolds what it thought", async () => {
    await thread([
      asked,
      {
        id: 2,
        role: "assistant",
        text: "Four.",
        citations: [],
        code: [],
        tools: [],
        reasoning: { text: "Add two to two.", ms: 3400 },
        end: "done",
        at: "2026-10-27T09:00:05.000Z",
      },
    ]);
    const folded = firstStep();
    await act(async () => {
      document.querySelector<HTMLElement>("button[aria-expanded]")?.click();
      await Promise.resolve();
    });

    expect([folded, firstStep()]).toStrictEqual([
      { line: "Thought for 3s", open: false, shows: undefined },
      { line: "Thought for 3s", open: true, shows: "Add two to two." },
    ]);
  });

  it("says under a code step each widget it made or changed on the dashboard, with the way there", async () => {
    const at = "2026-10-27T09:00:05.000Z";
    await thread(
      [
        asked,
        {
          id: 2,
          role: "assistant",
          text: "",
          citations: [],
          code: [{ callId: "step", code: "await env.dashboard.makeWidget()" }],
          tools: [],
          end: "done",
          at,
        },
        {
          id: 3,
          role: "result",
          callId: "step",
          text: "done",
          failed: false,
          at,
        },
      ],
      null,
      [
        {
          id: 1,
          callId: "step",
          method: "dashboard.makeWidget",
          target: null,
          summary: {},
          outcome: "ok",
          reason: null,
          at,
        },
      ]
    );
    const way = document.querySelector('a[href="/dashboard"]');

    expect({
      said: way?.parentElement?.textContent,
      step: document.querySelector("button[aria-expanded]")?.textContent,
    }).toStrictEqual({
      said: "Grasp added a widget to your dashboard. Open the dashboard",
      step: "Code stepDone",
    });
  });

  it("says what each call of Grasp's tools did in one line, and unfolds what it was given and what came of it", async () => {
    const at = "2026-10-27T09:00:05.000Z";
    await thread([
      asked,
      {
        id: 2,
        role: "assistant",
        text: "",
        citations: [],
        code: [],
        tools: [
          {
            callId: "write",
            tool: "writeFile",
            codeBefore: 0,
            input: {
              app: "app_1",
              files: { "src/routes/index.tsx": "export default" },
            },
          },
          {
            callId: "search",
            tool: "searchBrain",
            codeBefore: 0,
            input: { query: "expense policy" },
          },
        ],
        end: "done",
        at,
      },
      {
        id: 3,
        role: "result",
        callId: "write",
        text: 'Returned:\n{"changed":["src/routes/index.tsx"]}',
        failed: false,
        at,
      },
    ]);
    const lines = [...document.querySelectorAll("button[aria-expanded]")].map(
      (line) => line.textContent
    );
    await act(async () => {
      document.querySelector<HTMLElement>("button[aria-expanded]")?.click();
      await Promise.resolve();
    });
    const opened = firstStep().shows;

    expect({
      lines,
      given: opened?.includes('"src/routes/index.tsx": "export default"'),
      came: opened?.includes('{"changed":["src/routes/index.tsx"]}'),
      code: document.body.textContent.includes("Code step"),
    }).toStrictEqual({
      // The search has no result yet, and Grasp has stopped: it never ran.
      lines: [
        "Wrote src/routes/index.tsx",
        "Searching the brain for expense policyStopped",
      ],
      given: true,
      came: true,
      code: false,
    });
  });

  it("shows a response's tool calls and code steps in the order it made them", async () => {
    const at = "2026-10-27T09:00:05.000Z";
    const done = (id: number, callId: string): ChatMessage => ({
      id,
      role: "result",
      callId,
      text: "Returned:\nnull",
      failed: false,
      at,
    });
    await thread([
      asked,
      {
        id: 2,
        role: "assistant",
        text: "",
        citations: [],
        code: [
          {
            callId: "call",
            code: "await env.build.call('app_1', 'notes.list')",
          },
        ],
        tools: [
          {
            callId: "write",
            tool: "writeFile",
            codeBefore: 0,
            input: {
              app: "app_1",
              files: { "src/routes/index.tsx": "", "app.ts": "" },
            },
          },
          {
            callId: "edit",
            tool: "editFile",
            codeBefore: 1,
            input: { app: "app_1", path: "app.ts" },
          },
        ],
        end: "done",
        at,
      },
      done(3, "write"),
      done(4, "call"),
      done(5, "edit"),
    ]);

    expect(
      [...document.querySelectorAll("button[aria-expanded]")].map(
        (line) => line.textContent
      )
    ).toStrictEqual(["Wrote 2 files", "Code stepDone", "Edited app.ts"]);
  });

  it("fades each word of an answer in as it is written, where words come, and a kept answer stands still", async () => {
    await thread([asked], {
      text: "It adds up.\n\nFour, as **two** and two.",
      code: [],
      tools: [],
      reasoning: "",
    });
    const landing = [...document.querySelectorAll("span.animate-in")].map(
      (word) => word.textContent
    );
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await thread([
      asked,
      {
        id: 2,
        role: "assistant",
        text: "Four, as **two** and two.",
        citations: [],
        code: [],
        tools: [],
        end: "done",
        at: "2026-10-27T09:00:05.000Z",
      },
    ]);

    expect({
      landing,
      kept: document.querySelectorAll("span.animate-in").length,
    }).toStrictEqual({
      landing: ["Four,", "as", "two", "and", "two."],
      kept: 0,
    });
  });

  it("carries an answer's thinking as a picture that opens the brain, and the way there where it can't be drawn", async () => {
    const at = "2026-10-27T09:00:05.000Z";
    const thought: ChatMessage[] = [
      asked,
      {
        id: 2,
        role: "result",
        callId: "step",
        text: "Shown in the brain.",
        failed: false,
        at,
        thinking: {
          text: "Reading the work",
          notes: ["wf-report"],
          shape: "hours",
          move: "work",
        },
      },
      {
        id: 3,
        role: "assistant",
        text: "The weekly report takes most.",
        citations: [],
        code: [],
        tools: [],
        end: "done",
        at,
      },
    ];
    await thread(thought);
    const unread = await wayToBrain();
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await thread(thought, null, [], {
      teams: [],
      statements: [],
      workflows: [{ id: "wf-report", name: "Weekly report", hours: 6 }],
    });
    // The drawing is a lazy import: its first load outlasts waitFor's default
    // second on a busy runner.
    await vi.waitFor(
      async () => {
        await act(async () => {
          await Promise.resolve();
        });
        expect(document.querySelector('a[href^="/brain"] svg')).not.toBeNull();
      },
      { timeout: 10_000 }
    );

    expect({ unread, drawn: await wayToBrain() }).toStrictEqual({
      unread: {
        href: "/brain?think=chat%3A1",
        text: "See it in the brain",
        picture: false,
      },
      drawn: {
        href: "/brain?think=chat%3A1",
        // The step, the workflow's name as its title and under it, the way.
        text: "Reading the workWeekly reportWeekly reportSee it in the brain",
        picture: true,
      },
    });
  });
});
