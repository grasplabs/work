// @vitest-environment happy-dom
import type { ChatAsked, ChatMessage } from "@grasp-os/shared/chat";
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

import { AskOrCompose, answersText, pendingAsk } from "./asked-questions.tsx";
import type { AskAnswer } from "./asked-questions.tsx";

// What the chat's agent asks, in place of the box: one question at a time,
// an option or the person's own words for each, keys to pick and go on,
// and Send only once every question has an answer. Picking sends nothing:
// only Send does, and what it sends is the answers as plain text, with
// what was picked beside it for a page that asked itself.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const asked: ChatAsked = {
  callId: "call-1",
  questions: [
    {
      kind: "choice",
      header: "Rhythm",
      question: "How often?",
      options: [
        { label: "Daily", description: "Every working day" },
        { label: "Weekly", description: "On Mondays" },
      ],
      recommended: 1,
    },
    {
      kind: "choice",
      question: "To whom?",
      options: [{ label: "Me" }, { label: "My team" }, { label: "Finance" }],
      multiple: true,
    },
  ],
};

let root: Root | undefined;

const unmount = (): void => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.replaceChildren();
};

/**
 * The box's place, waiting on `asked`, in the app's frame, with the model
 * `model` to answer; records what it sent, and keeps a control of its own.
 */
const placed = async (model = "openai/gpt-5") => {
  const sent: { text: string; given: readonly AskAnswer[] }[] = [];
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <AskOrCompose
          asking={asked}
          busy={false}
          compact
          model={model}
          models={model === "" ? [] : [model]}
          onAnswer={(text, given) => {
            sent.push({ text, given });
          }}
          onSend={() => {
            // Typed questions go elsewhere.
          }}
          onText={() => {
            // Typed elsewhere.
          }}
          running={false}
          text=""
        >
          <button type="button">Open the chat</button>
        </AskOrCompose>
      ),
    }),
    history: createMemoryHistory(),
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
  return { sent };
};

/** What a button says, less the key it hints at (`Kbd`). */
const nameOf = (element: HTMLElement): string =>
  [...element.childNodes]
    .filter(
      (node) => !(node instanceof HTMLElement && node.dataset.slot === "kbd")
    )
    .map((node) => node.textContent)
    .join("")
    .trim();

const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) => nameOf(each) === name
  );
  if (found === undefined) {
    throw new Error(`No button ${name}`);
  }
  return found;
};

/** The option row labelled `label`, with its control. */
const option = (label: string): HTMLElement => {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[data-slot="ask-card-option"]'),
  ].find((each) => each.textContent.startsWith(label));
  if (found === undefined) {
    throw new Error(`No option ${label}`);
  }
  return found;
};

const click = (element: HTMLElement): void => {
  act(() => {
    element.click();
  });
};

/** Picks the option labelled `label`, as the person does: anywhere on its row. */
const pick = (label: string): void => {
  click(option(label));
};

/** Whether the option labelled `label` is picked. */
const picked = (label: string): boolean =>
  option(label).querySelector("[data-checked]") !== null;

/** Presses `key` where focus is, as the person does, with no click first. */
const press = (key: string): void => {
  const focused = document.activeElement ?? document.body;
  act(() => {
    focused.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
};

/** The option whose control has focus, by its label. */
const focusedOption = (): string | undefined =>
  document.activeElement
    ?.closest<HTMLElement>('[data-slot="ask-card-option"]')
    ?.querySelector(":scope > span:not([data-slot]) > span")?.firstChild
    ?.textContent ?? undefined;

/** Types `text` into the field for the person's own words. */
const typeOwn = (text: string): void => {
  const field = document.querySelector<HTMLInputElement>(
    'input[aria-label="Your answer"]'
  );
  if (field === null) {
    throw new Error("No field for their own words");
  }
  act(() => {
    const prototype = Reflect.getPrototypeOf(field) ?? {};
    Reflect.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      field,
      text
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const says = (text: string): boolean =>
  document.body.textContent.includes(text);

describe("questions in place of the box", () => {
  afterEach(unmount);

  it("goes one question at a time, sends nothing on a pick, and sends each answer after its question once the last has one", async () => {
    const { sent } = await placed();
    const shownFirst = {
      topic: says("Rhythm"),
      progress: says("1 of 2"),
      recommended: option("Weekly").textContent.includes("Recommended"),
      described: says("On Mondays"),
      next: button("Next").disabled,
    };
    pick("Weekly");
    const nextOnceAnswered = button("Next").disabled;
    click(button("Next"));
    pick("Me");
    pick("Finance");
    const sentBeforeSend = sent.length;
    click(button("Send"));

    expect({
      shownFirst,
      nextOnceAnswered,
      sentBeforeSend,
      sent,
    }).toStrictEqual({
      shownFirst: {
        topic: true,
        progress: true,
        recommended: true,
        described: true,
        next: true,
      },
      nextOnceAnswered: false,
      sentBeforeSend: 0,
      sent: [
        {
          // Each answer after the question it answers, so the message
          // reads right wherever it is read again.
          text: "1. How often? — Weekly\n2. To whom? — Me and Finance",
          given: [{ picked: [1] }, { picked: [0, 2] }],
        },
      ],
    });
  });

  it("picks by number, goes on and sends with Enter, and types instead with Esc", async () => {
    const { sent } = await placed();
    press("2");
    const focusMoved = focusedOption();
    press("1");
    const first = picked("Daily");
    press("Enter");
    press("2");
    press("3");
    press("2");
    const toWhom = ["Me", "My team", "Finance"].map(picked);
    press("Enter");
    const answered = [...sent];
    unmount();
    await placed();
    press("Escape");

    expect({
      focusMoved,
      first,
      toWhom,
      answered: answered.map(({ text }) => text),
      typing: document.querySelector('[role="textbox"]') !== null,
    }).toStrictEqual({
      // The key moves focus to what it picks.
      focusMoved: "Weekly",
      first: true,
      // 2 picked My team, 3 Finance, and 2 again took My team off.
      toWhom: [false, false, true],
      answered: ["1. How often? — Daily\n2. To whom? — Finance"],
      typing: true,
    });
  });

  it("puts focus on each question's picked option, or its first, as it shows", async () => {
    await placed();
    const shown = focusedOption();
    pick("Weekly");
    click(button("Next"));
    const next = focusedOption();
    click(button("Back"));

    expect({ shown, next, back: focusedOption() }).toStrictEqual({
      shown: "Daily",
      next: "Me",
      back: "Weekly",
    });
  });

  it("takes the person's own words, alone or beside what they picked", async () => {
    const { sent } = await placed();
    pick("In my own words");
    typeOwn(" Every other week ");
    click(button("Next"));
    pick("Me");
    pick("In my own words");
    typeOwn("the auditors");
    click(button("Send"));

    expect(sent).toStrictEqual([
      {
        text: "1. How often? — Every other week\n2. To whom? — Me and the auditors",
        given: [
          { picked: [], own: " Every other week " },
          { picked: [0], own: "the auditors" },
        ],
      },
    ]);
  });

  it("keeps the person's answers and question when they type instead and come back, beside the place's own controls", async () => {
    await placed();
    pick("Weekly");
    click(button("Next"));
    const own = button("Open the chat").type;
    click(button("Type instead"));
    const boxShown = document.querySelector('[role="textbox"]') !== null;
    click(button("Back to the 2 questions"));
    const onSecond = says("To whom?");
    click(button("Back"));

    expect({ own, boxShown, onSecond, kept: picked("Weekly") }).toStrictEqual({
      own: "button",
      boxShown: true,
      onSecond: true,
      kept: true,
    });
  });

  it("sends nothing while there is no model to answer, and shows how to connect an AI provider", async () => {
    const { sent } = await placed("");
    pick("Weekly");
    click(button("Next"));
    pick("Me");
    const sendDisabled = button("Send").disabled;
    click(button("Send"));

    expect({
      sendDisabled,
      sent,
      connect: says("Connect an AI provider"),
    }).toStrictEqual({ sendDisabled: true, sent: [], connect: true });
  });
});

describe(answersText, () => {
  it("sends one answer alone, the person's own words trimmed", () => {
    const [often] = asked.questions;
    if (often === undefined) {
      throw new Error("No question");
    }
    const one: ChatAsked = { callId: "c", questions: [often] };
    expect([
      answersText(one, [{ picked: [0] }]),
      answersText(one, [{ picked: [], own: " Every other week " }]),
    ]).toStrictEqual(["Daily", "Every other week"]);
  });
});

describe(pendingAsk, () => {
  const at = "2026-10-27T10:00:00.000Z";
  const reply = (id: number): ChatMessage => ({
    id,
    role: "assistant",
    text: "",
    citations: [],
    code: [],
    tools: [],
    asked,
    end: "done",
    at,
  });

  it("waits on the latest reply's questions while nothing runs and nothing was said since", () => {
    const result: ChatMessage = {
      id: 2,
      role: "result",
      callId: "call-1",
      text: "Asked.",
      failed: false,
      at,
    };
    const answer: ChatMessage = { id: 3, role: "user", text: "Weekly", at };
    expect([
      pendingAsk([reply(1), result], false)?.callId,
      pendingAsk([reply(1), result], true),
      pendingAsk([reply(1), result, answer], false),
    ]).toStrictEqual(["call-1", undefined, undefined]);
  });
});
