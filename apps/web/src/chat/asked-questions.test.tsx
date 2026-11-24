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
 * `model` to answer; records what it sent, which core takes while
 * `core.takes`, and keeps a control of its own.
 */
const placed = async (model = "openai/gpt-5") => {
  const sent: { text: string; given: readonly AskAnswer[] }[] = [];
  const core = { takes: true };
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <AskOrCompose
          asking={asked}
          busy={false}
          compact
          model={model}
          models={model === "" ? [] : [model]}
          onAnswer={async (text, given) => {
            sent.push({ text, given });
            return await Promise.resolve(core.takes);
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
  return { sent, core };
};

/** Lets the questions settle: what they scheduled, focus moved a frame on. */
const settle = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 20);
    await promise;
  });
};

const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) =>
      each.textContent.trim() === name && each.closest("[hidden]") === null
  );
  if (found === undefined) {
    throw new Error(`No button ${name}`);
  }
  return found;
};

/** The element whose ID is `id`. */
const byId = (id: string): Element | null =>
  document.querySelector(`[id="${id}"]`);

/** The choice named `label`: its radio, or its checkbox where several are taken. */
const choice = (label: string): HTMLElement => {
  const found = [
    ...document.querySelectorAll<HTMLElement>(
      '[role="radio"], [role="checkbox"]'
    ),
  ].find(
    (each) =>
      byId((each.getAttribute("aria-labelledby") ?? "").split(" ")[0] ?? "")
        ?.textContent === label
  );
  if (found === undefined) {
    throw new Error(`No choice ${label}`);
  }
  return found;
};

const click = async (element: HTMLElement): Promise<void> => {
  act(() => {
    element.click();
  });
  await settle();
};

/** Picks the choice named `label`, as the person does. */
const pick = async (label: string): Promise<void> => {
  await click(choice(label));
};

/** Whether the choice named `label` is picked. */
const picked = (label: string): boolean =>
  choice(label).getAttribute("aria-checked") === "true";

/** Presses `key` where focus is, as the person does, with no click first. */
const press = async (key: string): Promise<void> => {
  const focused = document.activeElement ?? document.body;
  act(() => {
    focused.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    );
  });
  await settle();
};

/** Types `text` into the field for the person's own words. */
const typeOwn = async (text: string): Promise<void> => {
  const field = [
    ...document.querySelectorAll<HTMLInputElement>('input[aria-label="Other"]'),
  ].find((each) => each.closest("[hidden]") === null);
  if (field === undefined) {
    throw new Error("No field for their own words");
  }
  act(() => {
    field.focus();
    const prototype = Reflect.getPrototypeOf(field) ?? {};
    Reflect.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      field,
      text
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
};

const says = (text: string): boolean =>
  document.body.textContent.includes(text);

/** Whether the box to ask in shows. */
const typing = (): boolean =>
  document.querySelector('[role="textbox"]') !== null;

describe("questions in place of the box", () => {
  afterEach(unmount);

  it("goes one question at a time, sends nothing on a pick, and sends each answer after its question once the last has one", async () => {
    const { sent } = await placed();
    const shownFirst = {
      topic: says("Rhythm"),
      progress: says("1 of 2"),
      recommended: (choice("Weekly").getAttribute("aria-labelledby") ?? "")
        .split(" ")
        .map((id) => document.querySelector(`#${id}`)?.textContent)
        .includes("Recommended"),
      described: says("On Mondays"),
      next: button("Next").disabled,
    };
    await pick("Weekly");
    const nextOnceAnswered = button("Next").disabled;
    await click(button("Next"));
    await pick("Me");
    await pick("Finance");
    const sentBeforeSend = sent.length;
    await click(button("Send answer"));

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
    choice("Daily").focus();
    await press("2");
    const second = picked("Weekly");
    await press("1");
    const first = picked("Daily");
    await press("Enter");
    choice("Me").focus();
    await press("2");
    await press("3");
    await press("2");
    const toWhom = ["Me", "My team", "Finance"].map(picked);
    await press("Enter");
    const answered = [...sent];
    unmount();
    await placed();
    choice("Daily").focus();
    await press("Escape");

    expect({
      second,
      first,
      toWhom,
      answered: answered.map(({ text }) => text),
      typing: typing(),
      inBox: document.activeElement?.getAttribute("role"),
    }).toStrictEqual({
      second: true,
      first: true,
      // 2 picked My team, 3 Finance, and 2 again took My team off.
      toWhom: [false, false, true],
      answered: ["1. How often? — Daily\n2. To whom? — Finance"],
      typing: true,
      inBox: "textbox",
    });
  });

  it("takes the person's own words, alone or beside what they picked", async () => {
    const { sent } = await placed();
    await typeOwn(" Every other week ");
    await click(button("Next"));
    await pick("Me");
    await typeOwn("the auditors");
    await click(button("Send answer"));

    expect(sent).toStrictEqual([
      {
        text: "1. How often? — Every other week\n2. To whom? — Me and the auditors",
        given: [
          { picked: [], own: "Every other week" },
          { picked: [0], own: "the auditors" },
        ],
      },
    ]);
  });

  it("keeps the person's answers and question when they type instead and come back, beside the place's own controls", async () => {
    await placed();
    await pick("Weekly");
    await click(button("Next"));
    const own = button("Open the chat").type;
    await click(button("Type instead"));
    const boxShown = typing();
    const inBox = document.activeElement?.getAttribute("role");
    await click(button("Back to the 2 questions"));
    const onSecond = says("To whom?") && !typing();
    // On the question shown, its first answer.
    const inQuestion = document.activeElement === choice("Me");
    await click(button("Previous"));

    expect({
      own,
      boxShown,
      inBox,
      onSecond,
      inQuestion,
      kept: picked("Weekly"),
    }).toStrictEqual({
      own: "button",
      boxShown: true,
      inBox: "textbox",
      onSecond: true,
      inQuestion: true,
      kept: true,
    });
  });

  it("keeps the choices and actions when core refuses the answers, to send them again or type instead", async () => {
    const { sent, core } = await placed();
    core.takes = false;
    await pick("Weekly");
    await click(button("Next"));
    await pick("Me");
    await click(button("Send answer"));
    const refused = {
      kept: picked("Me"),
      send: button("Send answer").disabled,
      typeInstead: button("Type instead").disabled,
    };
    core.takes = true;
    await click(button("Send answer"));

    expect({
      refused,
      tries: sent.length,
      choicesOnceTaken: document.querySelectorAll('[role="checkbox"]').length,
    }).toStrictEqual({
      refused: { kept: true, send: false, typeInstead: false },
      tries: 2,
      choicesOnceTaken: 0,
    });
  });

  it("sends nothing while there is no model to answer, and shows how to connect an AI provider", async () => {
    const { sent } = await placed("");
    await pick("Weekly");
    await click(button("Next"));
    await pick("Me");
    const sendDisabled = button("Send answer").disabled;
    await click(button("Send answer"));

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
