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
import "./test-thread-room.ts";

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

/** What core answers the page's undo of a memory. */
let forgetAnswer: "done" | "nothing" = "done";

const asked: ChatMessage = {
  id: 1,
  role: "user",
  text: "What is 2 + 2?",
  at: "2026-10-27T09:00:00.000Z",
};

/** A finished answer, `text`. */
const answer = (id: number, text: string): ChatMessage => ({
  id,
  role: "assistant",
  text,
  citations: [],
  code: [],
  tools: [],
  end: "done",
  at: "2026-10-27T09:00:05.000Z",
});

/** How many Ask again buttons show. */
const askAgain = (): number =>
  [...document.querySelectorAll("button")].filter(
    (button) => button.getAttribute("aria-label") === "Ask again"
  ).length;

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

/** What an element says, its copies hidden from assistive technology left out. */
const said = (element: Element | null | undefined): string | undefined => {
  if (element === null || element === undefined) {
    return undefined;
  }
  const copy = element.cloneNode(true);
  if (!(copy instanceof Element)) {
    return undefined;
  }
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) {
    hidden.remove();
  }
  return copy.textContent;
};

/** A line that folds open: what it says, whether it is open, and what it shows. */
const foldOf = (line: Element | null | undefined) => {
  const shows = line?.getAttribute("aria-controls");
  const open = line?.getAttribute("aria-expanded") === "true";
  return {
    line: said(line),
    open,
    shows:
      !open || shows === null || shows === undefined
        ? undefined
        : document.querySelector(`#${shows}`)?.textContent,
  };
};

/** The answer's thinking line: what it says, whether it is open, and what it shows. */
const thoughtButton = () =>
  [...document.querySelectorAll("article button[aria-expanded]")].find(
    (button) => /^(?:Thinking|Thought for)/u.test(said(button) ?? "")
  );

const thoughtLine = () => foldOf(thoughtButton());

/** Presses `button`, and lets what it opens settle. */
const press = async (button: Element | null | undefined): Promise<void> => {
  await act(async () => {
    if (button instanceof HTMLElement) {
      button.click();
    }
    await Promise.resolve();
  });
};

/** The line over each answer's steps. */
const activityLines = () => [
  ...document.querySelectorAll(
    'section[aria-label="What Grasp did"] button[aria-expanded]:not(li *)'
  ),
];

/** Opens every answer's steps. */
const openSteps = async (): Promise<void> => {
  for (const line of activityLines()) {
    // oxlint-disable-next-line no-await-in-loop -- one at a time, as a person opens them
    await press(line);
  }
};

/** Each step's line, as it reads. */
const stepLines = () =>
  [
    ...document.querySelectorAll(
      'section[aria-label="What Grasp did"] li button[aria-expanded]'
    ),
  ].map((line) => said(line));

/** The line over the answer Grasp works on: what it is doing now. */
const workingLine = () => said(activityLines()[0]);

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

  it("says when an undo found nothing to undo, never that it was forgotten", async () => {
    forgetAnswer = "nothing";
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
      told: text.includes(
        "There was nothing to undo: Grasp no longer uses this."
      ),
      claimedForgotten: text.includes("Grasp no longer remembers this."),
    }).toStrictEqual({ told: true, claimedForgotten: false });
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
    await openSteps();
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

  it("streams what the model thinks under Thinking, to open, before it says a word", async () => {
    await thread([asked], {
      text: "",
      code: [],
      tools: [],
      reasoning: "Add two to two.",
    });
    const closed = thoughtLine();
    await press(thoughtButton());
    // The thoughts come in at the pace an answer's words do.
    await vi.waitFor(() => {
      expect(thoughtLine().shows).toBe("Add two to two.");
    });

    expect([closed, thoughtLine()]).toStrictEqual([
      { line: "Thinking", open: false, shows: undefined },
      { line: "Thinking", open: true, shows: "Add two to two." },
    ]);
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
    const checking = workingLine();
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    // Running on without a check: what it does otherwise.
    await thread(answered, null, [], undefined, false);

    expect({ checking, otherwise: workingLine() }).toStrictEqual({
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
    const folded = thoughtLine();
    await press(thoughtButton());

    expect([folded, thoughtLine()]).toStrictEqual([
      { line: "Thought for 3 seconds", open: false, shows: undefined },
      { line: "Thought for 3 seconds", open: true, shows: "Add two to two." },
    ]);
  });

  it("says one thinking line at a time: how long it thought, then that it works on, never Thinking again", async () => {
    // It thought, then searched; the search answered and the turn runs on, no words yet.
    await thread(
      [
        asked,
        {
          id: 2,
          role: "assistant",
          text: "",
          citations: [],
          code: [],
          tools: [
            {
              callId: "search",
              tool: "searchBrain",
              codeBefore: 0,
              input: { query: "expense policy" },
            },
          ],
          reasoning: { text: "Look it up.", ms: 3400 },
          end: "done",
          at: "2026-10-27T09:00:05.000Z",
        },
        {
          id: 3,
          role: "result",
          callId: "search",
          text: "Returned:\n[]",
          failed: false,
          at: "2026-10-27T09:00:06.000Z",
        },
      ],
      null,
      [],
      undefined,
      false
    );

    expect({
      thought: thoughtLine().line,
      working: workingLine(),
    }).toStrictEqual({
      thought: "Thought for 3 seconds",
      working: "Working on it",
    });
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
    await openSteps();

    expect({
      said: said(way?.parentElement),
      steps: stepLines(),
    }).toStrictEqual({
      said: "Grasp added a widget to your dashboard. Open the dashboard",
      steps: ["Ran a code step, Done"],
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
    await openSteps();
    const lines = stepLines();
    const first = document.querySelector(
      'section[aria-label="What Grasp did"] li button[aria-expanded]'
    );
    await press(first);
    const opened = foldOf(first).shows;

    expect({
      lines,
      given: opened?.includes('"src/routes/index.tsx": "export default"'),
      came: opened?.includes('{"changed":["src/routes/index.tsx"]}'),
      code: document.body.textContent.includes("code step"),
    }).toStrictEqual({
      // The search has no result yet, and Grasp has stopped: it never ran.
      lines: [
        "Wrote src/routes/index.tsx, Done",
        "Searching the brain for expense policy, Stopped",
      ],
      given: true,
      came: true,
      code: false,
    });
  });

  it("says an answer was stopped part way, keeping its words without a link it was still writing", async () => {
    await thread([
      asked,
      {
        id: 2,
        role: "assistant",
        text: "Four, as the [policy](https://exam",
        citations: [],
        code: [],
        tools: [],
        end: "cancelled",
        at: "2026-10-27T09:00:05.000Z",
      },
    ]);
    const stopped = document.querySelector<HTMLElement>(
      'article[data-from="agent"]'
    );

    await vi.waitFor(() => {
      expect(document.querySelector("[data-slot=markdown]")?.textContent).toBe(
        "Four, as the"
      );
    });
    expect({
      status: stopped?.dataset.status,
      said: stopped?.textContent.includes("Stopped"),
    }).toStrictEqual({ status: "stopped", said: true });
  });

  it("offers to ask again under an answer with words, and nothing under one without", async () => {
    await thread([asked, answer(2, "Four.")]);
    const worded = askAgain();
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await thread([asked, answer(2, "")]);

    expect({ worded, wordless: askAgain() }).toStrictEqual({
      worded: 1,
      wordless: 0,
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

    await openSteps();

    expect(stepLines()).toStrictEqual([
      "Wrote 2 files, Done",
      "Ran a code step, Done",
      "Edited app.ts, Done",
    ]);
  });

  it("lets an answer's words out at a pace while it is written, and shows a kept answer whole", async () => {
    const text = "It adds up. Four, as two and two, which is what you asked.";
    await thread([asked], {
      text,
      code: [],
      tools: [],
      reasoning: "",
    });
    const writing = document.querySelector("[data-slot=markdown]")?.textContent;
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await thread([
      asked,
      {
        id: 2,
        role: "assistant",
        text,
        citations: [],
        code: [],
        tools: [],
        end: "done",
        at: "2026-10-27T09:00:05.000Z",
      },
    ]);

    expect({
      paced: writing !== undefined && writing.length < text.length,
      kept: document.querySelector("[data-slot=markdown]")?.textContent,
    }).toStrictEqual({ paced: true, kept: text });
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

  it("opens a link out of Grasp from an answer only once the person says so: a web page, an email, even Grasp's own address", async () => {
    const opened: string[] = [];
    vi.stubGlobal("open", (url: string) => {
      opened.push(url);
      return null;
    });
    const links = [
      "https://example.com/leave",
      "mailto:finance@example.com?subject=Leave",
      `${window.location.origin}/settings`,
    ];
    await thread([
      asked,
      {
        id: 2,
        role: "assistant",
        text: links.map((href, at) => `[Link ${at + 1}](${href})`).join(" "),
        citations: [],
        code: [],
        tools: [],
        end: "done",
        at: "2026-10-27T09:00:05.000Z",
      },
    ]);
    // No address on the page to follow past the question: not a middle
    // press, the browser's own "open link", a drag or a long press.
    const addresses = document.querySelectorAll("article a[href]").length;
    const questions: (string | undefined)[] = [];
    for (const [at] of links.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one link at a time, as a person presses them
      await press(
        [...document.querySelectorAll("button")].find(
          (button) => said(button) === `Link ${at + 1}`
        )
      );
      questions.push(
        document.querySelector('[role="alertdialog"]')?.textContent
      );
      // oxlint-disable-next-line no-await-in-loop -- one link at a time
      await press(
        [...document.querySelectorAll('[role="alertdialog"] button')].find(
          (button) => said(button) === "Cancel"
        )
      );
    }
    const before = [...opened];
    await press(
      [...document.querySelectorAll("button")].find(
        (button) => said(button) === "Link 2"
      )
    );
    await press(
      [...document.querySelectorAll('[role="alertdialog"] button')].find(
        (button) => said(button) === "Open link"
      )
    );
    vi.unstubAllGlobals();

    expect({
      addresses,
      asked: questions.map((text, at) => text?.includes(links[at] ?? "")),
      before,
      after: opened,
    }).toStrictEqual({
      addresses: 0,
      asked: [true, true, true],
      before: [],
      after: [links[1]],
    });
  });
});
