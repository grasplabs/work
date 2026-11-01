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

/**
 * The panel in the app's frame while the organization has no model to
 * answer (`model` empty, none to pick), recording what it sent.
 */
const shownWithoutModel = async () => {
  const sent: string[] = [];
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <AskedQuestions
          asked={asked}
          busy={false}
          failure={undefined}
          model=""
          models={[]}
          onSend={(text) => {
            sent.push(text);
          }}
          onType={() => {
            // Answered here, not typed.
          }}
        />
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

  it("goes one question at a time, sends nothing on a pick, and sends each answer after its question once the last has one", () => {
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
      // Each answer after the question it answers, so the message reads
      // right wherever it is read again, such as a chat opened later.
      sent: ["1. How often? — Weekly\n2. To whom? — My team"],
    });
  });

  it("sends nothing while there is no model to answer, and shows how to connect an AI provider", async () => {
    const { sent } = await shownWithoutModel();
    pick("Weekly");
    click(button("Next"));
    pick("My team");
    const sendDisabled = button("Send").disabled;
    click(button("Send"));

    expect({
      sendDisabled,
      sent,
      connect: document.body.textContent?.includes("Connect an AI provider"),
    }).toStrictEqual({ sendDisabled: true, sent: [], connect: true });
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
