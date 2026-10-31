// @vitest-environment happy-dom
import type { ChatAsked, ChatMessage } from "@grasp-os/shared/chat";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  AskOrCompose,
  AskedQuestions,
  answersText,
  pendingAsk,
} from "./asked-questions.tsx";

// The questions the chat's agent asked with choices, in place of the box
// (GRA-1001): one at a time, a choice or the person's own words for each,
// and Send only once every question has an answer. Picking sends nothing:
// only Send does, and what it sends is the answers as plain text.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const often = { question: "How often?", choices: ["Daily", "Weekly"] };

const asked: ChatAsked = {
  callId: "call-1",
  questions: [often, { question: "To whom?", choices: ["Me", "My team"] }],
};

let root: Root | undefined;

/** Takes the panel down after each test. */
const unmount = (): void => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.replaceChildren();
};

/** The panel, recording what it sent and whether the box was asked for. */
const shown = () => {
  const sent: string[] = [];
  const typed = { instead: false };
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <AskedQuestions
          asked={asked}
          busy={false}
          failure={undefined}
          onSend={(text) => {
            sent.push(text);
          }}
          onType={() => {
            typed.instead = true;
          }}
        />
      </I18nProvider>
    );
  });
  return { sent, typed };
};

/** The button named `name`. */
const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === name
  );
  if (found === undefined) {
    throw new Error(`No button ${name}`);
  }
  return found;
};

/** Picks the choice labelled `label`. */
const pick = (label: string): void => {
  const found = [...document.querySelectorAll("label")].find(
    (each) => each.textContent === label
  );
  const radio =
    found === undefined
      ? null
      : document.querySelector<HTMLElement>(`#${CSS.escape(found.htmlFor)}`);
  if (radio === null) {
    throw new Error(`No choice ${label}`);
  }
  act(() => {
    radio.click();
  });
};

const click = (element: HTMLElement): void => {
  act(() => {
    element.click();
  });
};

describe("questions with choices in place of the box", () => {
  afterEach(unmount);

  it("goes one question at a time, sends nothing on a pick, and sends only the answers, numbered, once the last has one", () => {
    const { sent } = shown();
    const nextAtFirst = button("Next").disabled;
    pick("Weekly");
    const nextOnceAnswered = button("Next").disabled;
    click(button("Next"));
    const sendAtLast = button("Send").disabled;
    pick("My team");
    const sentBeforeSend = sent.length;
    click(button("Send"));

    expect({
      nextAtFirst,
      nextOnceAnswered,
      sendAtLast,
      sentBeforeSend,
      sent,
    }).toStrictEqual({
      nextAtFirst: true,
      nextOnceAnswered: false,
      sendAtLast: true,
      sentBeforeSend: 0,
      // Only what the person picked: never the model's questions, which
      // would be words they never saw composed, sent as theirs.
      sent: ["1. Weekly\n2. My team"],
    });
  });

  it("gives the box back when the person types instead", () => {
    const { sent, typed } = shown();
    click(button("Type instead"));

    expect({ typed: typed.instead, sent }).toStrictEqual({
      typed: true,
      sent: [],
    });
  });
});

/** The latest reply, asking `asked`: what the place waits on. */
const asking: ChatMessage = {
  id: 1,
  role: "assistant",
  text: "",
  citations: [],
  code: [],
  asked,
  end: "done",
  at: "2026-10-27T10:00:00.000Z",
};

/** The box's place, waiting on `asked`, with a control of its own. */
const placed = (): void => {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <AskOrCompose
          busy={false}
          compact
          messages={[asking]}
          onAnswer={() => {
            // Sent elsewhere.
          }}
          onSend={() => {
            // Sent elsewhere.
          }}
          onText={() => {
            // Typed elsewhere.
          }}
          running={false}
          text=""
        >
          <button type="button">Open the chat</button>
        </AskOrCompose>
      </I18nProvider>
    );
  });
};

/** Whether the choice labelled `label` is the one picked. */
const picked = (label: string): boolean => {
  const found = [...document.querySelectorAll("label")].find(
    (each) => each.textContent === label
  );
  // The label names the choice's input, which says whether it is checked.
  return (
    found !== undefined &&
    document.querySelector<HTMLInputElement>(
      `input#${CSS.escape(found.htmlFor)}`
    )?.checked === true
  );
};

describe("the box's place while questions wait", () => {
  afterEach(unmount);

  it("keeps the person's answers and question when they type instead and come back", () => {
    placed();
    pick("Weekly");
    click(button("Next"));
    click(button("Type instead"));
    const boxShown = document.querySelector("textarea") !== null;
    click(button("Back to the 2 questions"));
    const onSecond = document.body.textContent?.includes("To whom?") ?? false;
    click(button("Back"));

    expect({ boxShown, onSecond, kept: picked("Weekly") }).toStrictEqual({
      boxShown: true,
      onSecond: true,
      kept: true,
    });
  });

  it("keeps the place's own controls beside the questions, such as the way to open the dock", () => {
    placed();

    expect({
      asking: document.body.textContent?.includes("How often?") ?? false,
      open: button("Open the chat").type,
    }).toStrictEqual({ asking: true, open: "button" });
  });
});

describe(answersText, () => {
  it("sends one answer alone, and the person's own words for something else", () => {
    const one = { callId: "c", questions: [often] };
    expect([
      answersText(one, [{ choice: "Daily", own: "" }]),
      answersText(one, [{ choice: "\u0000other", own: " Every other week " }]),
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
