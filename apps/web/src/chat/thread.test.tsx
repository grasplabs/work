import { setTimeout as sleep } from "node:timers/promises";

// @vitest-environment happy-dom
import type { ThinkingGround } from "@grasp-os/shared/brain";
import type {
  ChatAgent,
  ChatMessage,
  ChatPartial,
  ChatQueued,
  ChatToolEvent,
} from "@grasp-os/shared/chat";
import type { ModelWait } from "@grasp-os/shared/models";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { PendingQuestion } from "./pending-question.ts";
import { answerAgentsOf, ChatThread } from "./thread.tsx";
import { newLineRow } from "./unread.ts";

// An answer's steps as one chain of thought in the thread. What the model
// thought: while it thinks, its words stream in, open under "Thinking";
// once the answer is kept, a quiet line says how long it thought, folded,
// and opens to what it thought. Each step is a line of the chain, its call
// opening to what went in and came back. While an answer is written, it
// is busy; a kept one is done.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** The memories the page undid, by id, in order. */
const forgotten: string[] = [];

/** How often the thread asked for the queued questions to be sent now. */
const sentNow: string[] = [];

/** What core answers the page's undo of a memory. */
let forgetAnswer: "done" | "nothing" = "done";

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
  checking?: boolean,
  /** The agents the person may ask, which name the answers. */
  agents?: readonly ChatAgent[],
  /** The answer the New line goes over, the first the person hadn't seen. */
  newLineBefore?: number,
  /** What the chat read, as the page passes it. */
  sources?: ReactNode,
  /** What the turn's model request waits on, as core says. */
  modelWait?: ModelWait,
  /** The questions queued behind the answer, as core says. */
  queued?: readonly ChatQueued[],
  /** The question on its way, as the page passes it. */
  pending?: PendingQuestion
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      action: (session: {
        brain: { thinking: () => Promise<ThinkingGround> };
        brainMemories: {
          forget: (memory: string) => Promise<"done" | "nothing">;
        };
      }) => Promise<T>
    ): Promise<T> =>
      await action({
        brainMemories: {
          forget: async (memory) => {
            await Promise.resolve();
            forgotten.push(memory);
            return forgetAnswer;
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
        agents={agents}
        chatId="chat"
        loaded
        messages={messages}
        onRetry={() => {
          // Not asked again here.
        }}
        output={null}
        partial={partial}
        running={
          partial !== null || checking !== undefined || modelWait !== undefined
        }
        checking={checking}
        modelWait={modelWait ?? null}
        queued={queued}
        onSendNow={() => {
          sentNow.push("now");
        }}
        tools={tools}
        newLineBefore={newLineBefore}
        sources={sources}
        pending={pending}
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

/**
 * What an element says, as a screen reader reads its words: without the
 * copies drawn for the eye alone, and without a line's status in words.
 */
const spoken = (element: Element | null | undefined): string | undefined => {
  const copy = element?.cloneNode(true);
  if (!(copy instanceof Element)) {
    return undefined;
  }
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) {
    hidden.remove();
  }
  return copy.textContent.replace(/, (?:Working|Failed|Waiting)$/u, "");
};

/** The words of a line that folds open: its title. */
const titleOf = (line: Element | null | undefined) =>
  spoken(line?.querySelector('[data-slot="trace-title"]') ?? line);

/** The first step that folds open: its line, whether it is open, and what it shows. */
const firstStep = () => {
  const line = document.querySelector("button[aria-expanded]");
  const shows = line?.getAttribute("aria-controls");
  const open = line?.getAttribute("aria-expanded") === "true";
  return {
    line: titleOf(line),
    open,
    // What it shows while open: a folded panel keeps its words, unseen.
    shows:
      !open || shows === null || shows === undefined
        ? undefined
        : document.querySelector(`#${shows}`)?.textContent,
  };
};

/** Grasp's answer in the thread. */
const answer = () =>
  document.querySelector<HTMLElement>('article[aria-label="Grasp"]');

/** Which of Grasp's answers hold what the chat read, in order. */
const holdingWhatWasRead = () =>
  [...document.querySelectorAll('article[aria-label="Grasp"]')].map(
    (each) => each.querySelector('[data-testid="read"]') !== null
  );

/** What the line over the answer says while Grasp works on it. */
const workingLine = () =>
  spoken(document.querySelector('[data-slot="shimmer"]'));

/**
 * Where the working mark on the line over the answer stands: in the mark's
 * place before its words, as a step's mark does; inside its words; or none.
 */
const markOnLine = () => {
  const line = document.querySelector(
    '[data-slot="chain-of-thought"] button[aria-expanded] > [data-slot="trace-line"]'
  );
  const mark = line?.querySelector('[data-slot="agent-indicator"]');
  if (mark === null || mark === undefined) {
    return "none";
  }
  return mark.closest('[data-slot="trace-title"]') === null &&
    mark.closest('[data-slot="trace-icon"]') === line?.firstElementChild
    ? "in the mark's place"
    : "in the words";
};

/** The answer's steps, in order: each step's words. */
const stepLines = () =>
  [
    ...document.querySelectorAll(
      '[data-slot="chain-of-thought"] [role="listitem"]'
    ),
  ].map((step) => titleOf(step));

/** Opens the answer's steps, as a press on their line does. */
const openSteps = async () => {
  await act(async () => {
    document
      .querySelector<HTMLElement>(
        '[data-slot="chain-of-thought"] button[aria-expanded]'
      )
      ?.click();
    await Promise.resolve();
  });
};

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
    forgetAnswer = "done";
    sentNow.length = 0;
  });

  it("draws the questions queued behind the answer last, in order, each saying so, Send now on the newest", async () => {
    await thread(
      [asked],
      {
        text: "Four",
        reasoning: "",
        code: [],
        tools: [],
      },
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [
        { id: "7", text: "And 3 + 3?" },
        { id: "8", text: "And 4 + 4?" },
      ]
    );
    const rows = [...document.querySelectorAll('[data-slot="message"]')];
    const sendNow = [...document.querySelectorAll("button")].filter(
      (button) => button.textContent.trim() === "Send now"
    );
    act(() => {
      sendNow[0]?.click();
    });

    expect({
      // The question, the answer being written, then each queued one.
      last: rows.slice(-2).map((row) => row.textContent),
      sendNow: sendNow.length,
      newest: rows.at(-1)?.contains(sendNow[0] ?? null),
      sentNow,
    }).toStrictEqual({
      last: ["And 3 + 3?Queued", "And 4 + 4?QueuedSend now"],
      sendNow: 1,
      newest: true,
      sentNow: ["now"],
    });
  });

  it("says under a call of remember who or what it is about, when it isn't the person", async () => {
    const at = "2026-10-27T09:00:05.000Z";
    await thread([
      asked,
      {
        id: 2,
        role: "assistant",
        text: "",
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
      "About Bob: Prefers answers by mail"
    );
  });

  it("says under a call of remember what the memory replaced", async () => {
    const at = "2026-10-27T09:00:05.000Z";
    await thread([
      asked,
      {
        id: 2,
        role: "assistant",
        text: "",
        code: [],
        tools: [
          {
            callId: "remember",
            tool: "remember",
            codeBefore: 0,
            input: { statement: "Loves sushi" },
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
          type: "preference",
          statement: "Loves sushi",
          replaced: ["Loves pizza", "Loves pasta"],
        },
      },
    ]);

    const saying = document.body.textContent;
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "Undo")
        ?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Removed from memory");
    });

    expect({
      saved: saying.includes("In place of: Loves pizza and Loves pasta"),
      undone: document.body.textContent.includes(
        "Restored: Loves pizza and Loves pasta"
      ),
    }).toStrictEqual({ saved: true, undone: true });
  });

  it("says when an undo found nothing to undo, never that it was forgotten", async () => {
    forgetAnswer = "nothing";
    const at = "2026-10-27T09:00:05.000Z";
    await thread([
      asked,
      {
        id: 2,
        role: "assistant",
        text: "",
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
        saved: {
          memory: "3f1c4a8e-5d6b-4c2a-9e7f-1a2b3c4d5e6f",
          type: "fact",
          statement: "Acme renews on 1 March",
        },
      },
    ]);
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "Undo")
        ?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(forgotten).toHaveLength(1);
    });
    const text = document.body.textContent;

    expect({
      told: text.includes("Already removed"),
      claimedRemoved: text.includes("Removed from memory"),
    }).toStrictEqual({ told: true, claimedRemoved: false });
  });

  it("says under a call of remember what it saved to memory, in the person's words, and undoes it there", async () => {
    const at = "2026-10-27T09:00:05.000Z";
    const memory = "3f1c4a8e-5d6b-4c2a-9e7f-1a2b3c4d5e6f";
    await thread([
      asked,
      {
        id: 2,
        role: "assistant",
        text: "",
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
    // The steps are drawn once opened.
    const summary = firstStep().line;
    await openSteps();
    const steps = stepLines();
    const shown = document.body.textContent;
    const undo = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Undo"
    );
    await act(async () => {
      undo?.focus();
      undo?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain(
        "Removed from memory, Acme renews on 1 March"
      );
    });

    expect({
      summary,
      line: steps,
      notice: shown.includes("Saved to memory, Acme renews on 1 March"),
      forgotten,
      undoLeft: [...document.querySelectorAll("button")].some(
        (button) => button.textContent === "Undo"
      ),
      focusInAnswer: document.activeElement === answer(),
    }).toStrictEqual({
      summary: "Saved 1 memory 5.0s",
      line: ["Saved to memory"],
      notice: true,
      forgotten: [memory],
      undoLeft: false,
      focusInAnswer: true,
    });
  });

  it("streams what the model thinks, open under Thinking, before it says a word", async () => {
    await thread([asked], {
      text: "",
      code: [],
      tools: [],
      reasoning: "Add two to two.",
    });

    // Whole words while it is written: the last waits for what follows it,
    // then shows once nothing more has come for a moment.
    const atFirst = firstStep();
    await act(async () => {
      await sleep(250);
    });
    expect({ atFirst, later: firstStep() }).toStrictEqual({
      atFirst: { line: "Thinking", open: true, shows: "Add two to" },
      later: { line: "Thinking", open: true, shows: "Add two to two." },
    });
  });

  it("streams what the model thinks again after a reply of its answer, open under Thinking", async () => {
    await thread(
      [
        asked,
        {
          id: 2,
          role: "assistant",
          text: "Let me check.",
          code: [],
          tools: [],
          end: "done",
          at: "2026-10-27T09:00:05.000Z",
        },
      ],
      { text: "", code: [], tools: [], reasoning: "Add two to two." }
    );

    // Whole words while it is written: the last waits for what follows it,
    // then shows once nothing more has come for a moment.
    const atFirst = firstStep();
    await act(async () => {
      await sleep(250);
    });
    expect({ atFirst, later: firstStep() }).toStrictEqual({
      atFirst: { line: "Thinking", open: true, shows: "Add two to" },
      later: { line: "Thinking", open: true, shows: "Add two to two." },
    });
  });

  it("says it checks the App while its turn checks the drafts it wrote, past its answer", async () => {
    const answered: ChatMessage[] = [
      asked,
      {
        id: 2,
        role: "assistant",
        text: "The desk is written.",
        code: [],
        tools: [],
        end: "done",
        at: "2026-10-27T09:00:05.000Z",
      },
    ];
    await thread(answered, null, [], undefined, true);
    const checking = workingLine();
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    // Running on without a check: what it does otherwise.
    await thread(answered, null, [], undefined, false);

    expect({ checking, otherwise: workingLine() }).toStrictEqual({
      checking: "Checking the App…",
      otherwise: "Working on it",
    });
  });

  it("says while the model waits on its provider's rate limit, or which model answers instead, before its answer and between its replies", async () => {
    const answered: ChatMessage[] = [
      asked,
      {
        id: 2,
        role: "assistant",
        text: "Let me look.",
        code: [],
        tools: [],
        end: "done",
        at: "2026-10-27T09:00:05.000Z",
      },
    ];
    const lineFor = async (
      messages: readonly ChatMessage[],
      modelWait: ModelWait
    ) => {
      await thread(
        messages,
        null,
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        modelWait
      );
      const line = workingLine();
      act(() => {
        root?.unmount();
      });
      document.body.replaceChildren();
      return line;
    };

    expect({
      before: await lineFor([asked], { kind: "rate_limited", seconds: 20 }),
      between: await lineFor(answered, { kind: "rate_limited", seconds: 1 }),
      instead: await lineFor([asked], {
        kind: "fallback",
        model: "mistral/mistral-large-latest",
      }),
    }).toStrictEqual({
      before: "Your AI provider is busy. Grasp tries again in 20 seconds.",
      between: "Your AI provider is busy. Grasp tries again in 1 second.",
      instead: "Answering with mistral-large-latest instead.",
    });
  });

  it("shows the working mark in the line's own mark place while it works closed, and none on the line once open", async () => {
    await thread(
      [
        asked,
        {
          id: 2,
          role: "assistant",
          text: "Let me check.",
          code: [],
          tools: [],
          end: "done",
          at: "2026-10-27T09:00:05.000Z",
        },
      ],
      null,
      [],
      undefined,
      false
    );
    const closed = markOnLine();
    await openSteps();

    expect({ closed, open: markOnLine() }).toStrictEqual({
      closed: "in the mark's place",
      open: "none",
    });
  });

  it("says over a kept answer how long the model thought, and unfolds what it thought", async () => {
    await thread([
      asked,
      {
        id: 2,
        role: "assistant",
        text: "Four.",
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
      { line: "Thought for 3 seconds", open: false, shows: undefined },
      { line: "Thought for 3 seconds", open: true, shows: "Add two to two." },
    ]);
  });

  it("says nothing of a thought it never saw until it is saved, then all rounds' time together", async () => {
    const first: ChatMessage = {
      id: 2,
      role: "assistant",
      text: "Let me check.",
      code: [],
      tools: [],
      reasoning: { text: "Look it up.", ms: 2000 },
      end: "done",
      at: "2026-10-27T09:00:05.000Z",
    };
    // The second round has thought and is writing its words.
    await thread([asked, first], {
      text: "Fo",
      code: [],
      tools: [],
      reasoning: "Add two to two.",
    });
    const writing = firstStep().line;
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await thread([
      asked,
      first,
      {
        id: 3,
        role: "assistant",
        text: "Four.",
        code: [],
        tools: [],
        reasoning: { text: "Add two to two.", ms: 3000 },
        end: "done",
        at: "2026-10-27T09:00:09.000Z",
      },
    ]);

    expect({ writing, saved: firstStep().line }).toStrictEqual({
      // Not seen thinking here and not timed yet: no line of its thinking.
      writing: undefined,
      saved: "Thought for 5 seconds",
    });
  });

  it("draws a question on its way as the person's own at once, after the chat's last answer", async () => {
    const at = "2026-10-27T09:00:05.000Z";
    await thread(
      [
        asked,
        {
          id: 2,
          role: "assistant",
          text: "Four.",
          code: [],
          tools: [],
          end: "done",
          at,
        },
      ],
      null,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        text: "And 3 + 3?",
        mentions: [],
        files: [{ id: "f1", file: new File(["1,2"], "sums.csv") }],
        after: 2,
        at,
        queues: false,
        key: "key-1",
        owner: "box",
        fromBox: true,
        state: "sending",
      }
    );

    const rows = [...document.querySelectorAll("article")].map(
      (row) => `${row.getAttribute("aria-label") ?? "You"}: ${row.textContent}`
    );
    expect(rows).toStrictEqual([
      expect.stringMatching(/^You: What is 2 \+ 2\?/u),
      expect.stringMatching(/^Grasp: Four\./u),
      expect.stringMatching(/^You: sums\.csv.*And 3 \+ 3\?/u),
    ]);
  });

  it("says what each call of Grasp's tools did in one line, and unfolds what it was given and what came of it", async () => {
    const at = "2026-10-27T09:00:05.000Z";
    await thread([
      asked,
      {
        id: 2,
        role: "assistant",
        text: "",
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
            input: { question: "expense policy" },
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
    await openSteps();
    const lines = stepLines();
    // The first step's call, opened to what went in and came back.
    await act(async () => {
      document
        .querySelector<HTMLElement>('[role="listitem"] button[aria-expanded]')
        ?.click();
      await Promise.resolve();
    });
    const call = document.querySelector('[role="listitem"]');
    const opened = call?.textContent;

    expect({
      lines,
      given: opened?.includes('"src/routes/index.tsx": "export default"'),
      came: opened?.includes('{"changed":["src/routes/index.tsx"]}'),
      stopped: document
        .querySelectorAll('[role="listitem"]')[1]
        ?.textContent.includes(", Stopped"),
      code: document.body.textContent.includes("code step"),
    }).toStrictEqual({
      // The search has no result yet, and Grasp has stopped: it never ran.
      lines: [
        "Wrote src/routes/index.tsx",
        "Searching the brain for expense policy",
      ],
      given: true,
      came: true,
      stopped: true,
      code: false,
    });
  });

  it("says why a failed step failed, its input as JSON, and counts it as failed too", async () => {
    const at = "2026-10-27T09:00:05.000Z";
    await thread([
      asked,
      {
        id: 2,
        role: "assistant",
        text: "",
        code: [],
        tools: [
          {
            callId: "again",
            tool: "searchBrain",
            codeBefore: 0,
            input: { question: "travel policy" },
          },
          // Failed last, so no later search recovered it.
          {
            callId: "search",
            tool: "searchBrain",
            codeBefore: 0,
            input: { question: "expense policy" },
          },
        ],
        end: "done",
        at,
      },
      {
        id: 3,
        role: "result",
        callId: "search",
        text: "The brain could not be searched.",
        failed: true,
        at,
      },
      {
        id: 4,
        role: "result",
        callId: "again",
        text: "Returned:\n[]",
        failed: false,
        at,
      },
      {
        id: 5,
        role: "assistant",
        text: "Nothing found.",
        code: [],
        tools: [],
        end: "done",
        at,
      },
    ]);
    const line = spoken(
      document.querySelector(
        '[data-slot="chain-of-thought"] button[aria-expanded]'
      )
    );
    await openSteps();
    const [, failed] = document.querySelectorAll('[role="listitem"]');
    await act(async () => {
      failed?.querySelector<HTMLElement>("button[aria-expanded]")?.click();
      await Promise.resolve();
    });
    const [input, error] = [...(failed?.querySelectorAll("pre") ?? [])].map(
      (block) => ({
        label: block.previousElementSibling?.textContent,
        text: block.textContent,
      })
    );

    expect({ line, input, error }).toStrictEqual({
      // Both searches ran; the one that failed is counted again as failed.
      line: "Searched 2 times; 1 step failed 5.0s",
      input: {
        label: "Input",
        text: JSON.stringify({ question: "expense policy" }, null, 2),
      },
      error: {
        label: "Why it failed",
        text: "The brain could not be searched.",
      },
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

    await openSteps();

    expect(stepLines()).toStrictEqual([
      "Wrote 2 files",
      "Ran a code step",
      "Edited app.ts",
    ]);
  });

  it("shows an answer as it is written, busy until it is kept, then done", async () => {
    await thread([asked], {
      text: "It adds up.\n\nFour, as **two** and two.",
      code: [],
      tools: [],
      reasoning: "",
    });
    const writing = {
      status: answer()?.dataset.status,
      words: answer()?.textContent.includes("It adds up."),
    };
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
        code: [],
        tools: [],
        end: "done",
        at: "2026-10-27T09:00:05.000Z",
      },
    ]);

    expect({
      writing,
      kept: answer()?.dataset.status,
    }).toStrictEqual({
      writing: { status: "streaming", words: true },
      kept: "done",
    });
  });

  it("folds what the chat read under its last answer's words once that is done, and under no other", async () => {
    const read = <p data-testid="read">Read Linear</p>;
    const four: ChatMessage = {
      id: 2,
      role: "assistant",
      text: "Four.",
      code: [],
      tools: [],
      end: "done",
      at: "2026-10-27T09:00:05.000Z",
    };
    const again: ChatMessage = { ...asked, id: 3, text: "And 3 + 3?" };
    const six: ChatMessage = { ...four, id: 4, text: "Six." };
    await thread(
      [asked, four, again],
      { text: "Six", code: [], tools: [], reasoning: "" },
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      read
    );
    const writing = holdingWhatWasRead();
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await thread(
      [asked, four, again, six],
      null,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      read
    );

    expect({ writing, done: holdingWhatWasRead() }).toStrictEqual({
      writing: [false, false],
      done: [false, true],
    });
  });

  describe("an answer stopped part way says so once, under its words", () => {
    const at = "2026-10-27T09:00:05.000Z";
    /** A reply of the answer, ended as `end`. */
    const reply = (
      id: number,
      text: string,
      end: "done" | "cancelled"
    ): ChatMessage => ({
      id,
      role: "assistant",
      text,
      code: [],
      tools: [],
      end,
      at,
    });
    /**
     * What the stopped answer shows: its words, and each Stopped shown. Damsko
     * draws Stopped on the actions' row when the answer has actions, and hides
     * the one under its words then (by CSS, which this DOM does not apply).
     */
    const shown = () => ({
      status: answer()?.dataset.status,
      notes: [
        ...(answer()?.querySelectorAll(
          answer()?.querySelector('[data-slot="message-actions"]')
            ? '[data-slot="message-actions"] [data-slot="message-stopped"]'
            : '[data-slot="message-stopped"]'
        ) ?? []),
      ].map((note) => note.textContent),
      words: [
        ...(answer()?.querySelectorAll('[data-slot="message-response"]') ?? []),
      ].map((response) => response.textContent),
    });

    it("with two written parts", async () => {
      await thread([
        asked,
        reply(2, "Let me look.", "done"),
        reply(3, "It is four, as", "cancelled"),
      ]);

      expect(shown()).toStrictEqual({
        status: "stopped",
        notes: ["Stopped"],
        words: ["Let me look.It is four, as"],
      });
    });

    it("with one", async () => {
      await thread([asked, reply(2, "It is four, as", "cancelled")]);

      expect(shown()).toStrictEqual({
        status: "stopped",
        notes: ["Stopped"],
        words: ["It is four, as"],
      });
    });

    it("stopped before any words", async () => {
      await thread([asked, reply(2, "", "cancelled")]);

      expect(shown()).toStrictEqual({
        status: "stopped",
        notes: ["Stopped"],
        words: [""],
      });
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
    // As long as the drawing's first load may take, beside the waits above.
  }, 20_000);
});

/** An answer, by the agent `agentId`. */
const answerBy = (id: number, text: string, agentId?: string): ChatMessage => ({
  id,
  role: "assistant",
  ...(agentId === undefined ? {} : { agentId }),
  text,
  code: [],
  tools: [],
  end: "done",
  at: "2026-10-27T09:00:01.000Z",
});
/** A question. */
const questionOf = (id: number, text: string): ChatMessage => ({
  id,
  role: "user",
  text,
  at: "2026-10-27T09:00:00.000Z",
});
/** An agent the person may ask. */
const agentOf = (id: string, name: string): ChatAgent => ({
  id,
  name,
  face: "pen",
  job: "",
  model: null,
  own: false,
});

describe("answers given by the agents a question addressed", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("names an answer only where another agent gave it than the one before it, and none in a chat one agent answers", () => {
    const one = [
      questionOf(1, "Hi"),
      answerBy(2, "Hello", "a"),
      answerBy(3, "More", "a"),
    ];
    const several = [
      questionOf(1, "@Claire @Pat hi"),
      answerBy(2, "Claire here", "claire"),
      answerBy(3, "Still Claire", "claire"),
      answerBy(4, "Pat here", "pat"),
      questionOf(5, "And?"),
      answerBy(6, "Pat again", "pat"),
      // Kept before answers named their agent: named by none.
      answerBy(7, "Older"),
    ];
    expect({
      one: [...answerAgentsOf(one)],
      several: [...answerAgentsOf(several)],
    }).toStrictEqual({
      one: [],
      several: [
        [2, "claire"],
        [4, "pat"],
      ],
    });
  });

  it("names the next agent over the answer it is writing, before it is kept", async () => {
    await thread(
      [questionOf(1, "@Claire @Pat hi"), answerBy(2, "Claire here", "claire")],
      { agentId: "pat", text: "Pat wri", code: [], tools: [], reasoning: "" },
      [],
      undefined,
      undefined,
      [agentOf("claire", "Claire"), agentOf("pat", "Pat")]
    );
    // The names over answers: Claire's kept answer names none until
    // another is kept, and Pat's being written is named.
    const named = [...document.querySelectorAll("article")]
      .map((each) => each.getAttribute("aria-label"))
      .filter((each) => each === "Claire" || each === "Pat");
    expect(named).toStrictEqual(["Pat"]);
  });

  it("shows the agent's name over its first answer, and says so of one the person can no longer ask", async () => {
    await thread(
      [
        questionOf(1, "@Claire @Gone hi"),
        answerBy(2, "Claire here", "claire"),
        answerBy(3, "Gone here", "gone"),
      ],
      null,
      [],
      undefined,
      undefined,
      [agentOf("claire", "Claire")]
    );
    const text = document.body.textContent ?? "";
    expect({
      claire: text.indexOf("Claire") < text.indexOf("Claire here"),
      gone: text.includes("An agent you can no longer ask"),
    }).toStrictEqual({ claire: true, gone: true });
  });
});

/** The words of the thread's day lines, in order. */
const dayLines = (): string[] =>
  [...document.querySelectorAll("[role='log'] [data-slot='separator']")]
    .map((line) => line.parentElement?.textContent ?? "")
    .filter((words, at, all) => words !== "" && all.indexOf(words) === at);

describe("a thread's day lines", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("opens a thread from an earlier day with its day, and draws a line where the day changes, none over today's", async () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 28, 12), toFake: ["Date"] });
    await thread([
      {
        ...questionOf(1, "Before"),
        at: new Date(2026, 9, 26, 9).toISOString(),
      },
      { ...answerBy(2, "Then"), at: new Date(2026, 9, 26, 9, 1).toISOString() },
      {
        ...questionOf(3, "And now?"),
        at: new Date(2026, 9, 27, 9).toISOString(),
      },
      { ...answerBy(4, "Yes"), at: new Date(2026, 9, 28, 9).toISOString() },
    ]);
    const earlier = dayLines();
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await thread([
      { ...questionOf(1, "Hi"), at: new Date(2026, 9, 28, 9).toISOString() },
      {
        ...answerBy(2, "Hello"),
        at: new Date(2026, 9, 28, 9, 1).toISOString(),
      },
    ]);

    expect({ earlier, today: dayLines() }).toStrictEqual({
      earlier: ["Monday, October 26", "Yesterday", "Today"],
      today: [],
    });
  });
});

/** The thread's New line: the separator named New, if there is one. */
const newLine = () =>
  [
    ...document.querySelectorAll<HTMLElement>(
      "[role='log'] [role='separator'][aria-labelledby]"
    ),
  ].find(
    (line) =>
      document.querySelector(
        `[id="${line.getAttribute("aria-labelledby") ?? ""}"]`
      )?.textContent === "New"
  ) ?? null;

/** Whether `first` stands before `second` in the thread. */
const before = (first: Element | null, second: Element | null): boolean => {
  const all = [...document.querySelectorAll("[role='log'] *")];
  const at = first === null ? -1 : all.indexOf(first);
  return at !== -1 && second !== null && all.indexOf(second) > at;
};

/** The element holding exactly `words`. */
const said = (words: string): HTMLElement | null =>
  [...document.querySelectorAll<HTMLElement>("[role='log'] *")].findLast(
    (element) => element.textContent.trim() === words
  ) ?? null;

/** A chat answered while the person was away: their question, and the answer they hadn't seen. */
const cameBack = [
  questionOf(1, "What do we owe?"),
  answerBy(2, "About 4,000."),
  questionOf(3, "And next month?"),
  answerBy(4, "About 3,500."),
];

/** Whether `element` is the log that scrolls. */
const isLog = (element: Element): boolean =>
  element instanceof HTMLElement &&
  element.dataset.slot === "message-scroller-viewport";

// Where the thread opens with a New line, as the browser lays it out:
// happy-dom lays nothing out, so the rows' sizes, which rows the browser
// has drawn (the rest skipped while out of view) and the size changes
// that place the line are given here. The view is 600px tall and the
// line 900px down the rows.
const laidOut = ({
  height,
  drawnRows,
}: {
  height: number;
  drawnRows: readonly string[];
}) => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function scrollHeight(this: HTMLElement) {
      return isLog(this) ? height : 0;
    }
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function clientHeight(this: HTMLElement) {
      return isLog(this) ? 600 : 0;
    }
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function rect(this: HTMLElement) {
      const top = this.dataset.messageId === newLineRow ? 900 : 0;
      return DOMRect.fromRect({ x: 0, y: top, width: 600, height: 40 });
    }
  );
  vi.spyOn(Element.prototype, "checkVisibility").mockImplementation(
    function checkVisibility(this: Element) {
      const row = this.parentElement?.dataset.messageId;
      return row !== undefined && drawnRows.includes(row);
    }
  );
  // Each size watch hears the sizes once, as the browser's first does.
  vi.stubGlobal(
    "ResizeObserver",
    class implements ResizeObserver {
      readonly #heard: ResizeObserverCallback;
      #watching = false;
      constructor(heard: ResizeObserverCallback) {
        this.#heard = heard;
      }
      observe() {
        this.#watching = true;
        queueMicrotask(() => {
          if (this.#watching) {
            this.#heard([], this);
          }
        });
      }
      unobserve() {
        this.#watching = false;
      }
      disconnect() {
        this.#watching = false;
      }
    }
  );
  return vi.spyOn(HTMLElement.prototype, "scrollTo");
};

describe("a thread's New line", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("stands over the first answer the person hadn't seen, after their own question, as a separator named New that takes no focus", async () => {
    await thread(cameBack, null, [], undefined, undefined, undefined, 4);
    const line = newLine();

    expect({
      after: before(said("And next month?"), line),
      over: before(line, said("About 3,500.")),
      words: line?.textContent,
      focusable: line?.querySelector("[tabindex], a, button") ?? null,
      focused: document.activeElement === document.body,
    }).toStrictEqual({
      after: true,
      over: true,
      words: "New",
      focusable: null,
      focused: true,
    });
  });

  it("is not drawn when nothing was unread", async () => {
    await thread(cameBack);
    expect(newLine()).toBeNull();
  });

  /** The thread's rows' ids, in order: the line, and the answer under it. */
  const cameBackRows = ["q1", "a2", "q3", newLineRow, "a4"];

  it("goes to the New line when it lies further from the view than the browser draws: the end not drawn, as after scrolling back before the dock closed", async () => {
    const scrolled = laidOut({ height: 2000, drawnRows: ["q1", "a2"] });
    await thread(cameBack, null, [], undefined, undefined, undefined, 4);
    await act(async () => {
      await Promise.resolve();
    });
    // At once, never animated.
    expect(scrolled).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: "auto" })
    );
  });

  it("waits, going nowhere, while the browser has drawn no row yet, and stays at the end when what is unread fits", async () => {
    const waiting = laidOut({ height: 2000, drawnRows: [] });
    await thread(cameBack, null, [], undefined, undefined, undefined, 4);
    await act(async () => {
      await Promise.resolve();
    });
    const whileNoneDrawn = waiting.mock.calls.length;
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    vi.restoreAllMocks();
    const fitting = laidOut({ height: 1400, drawnRows: cameBackRows });
    await thread(cameBack, null, [], undefined, undefined, undefined, 4);
    await act(async () => {
      await Promise.resolve();
    });

    expect({ whileNoneDrawn, fits: fitting.mock.calls.length }).toStrictEqual({
      whileNoneDrawn: 0,
      fits: 0,
    });
  });
});
