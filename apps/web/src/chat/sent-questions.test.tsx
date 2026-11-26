// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  forgetSentQuestions,
  isSending,
  questionRefused,
  questionSent,
  sendBegan,
  sendEnded,
  turnEnded,
  useSentQuestions,
} from "./sent-questions.ts";
import type { SentQuestion } from "./sent-questions.ts";

// The questions a tab sent that core hasn't shown back: one on its way in
// a chat holds the next back, so none overtakes it, and an answer that
// ends meanwhile (another tab's) never takes away a question still on its
// way, nor one core refused.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const question = (key: string): SentQuestion => ({
  key,
  text: `Question ${key}`,
  at: "2026-11-26T09:00:00.000Z",
  files: [],
  mentions: [],
});

/** The questions the chat shows now, by key and whether refused. */
const Probe = () => (
  <output>
    {useSentQuestions("chat-1", [])
      .map(
        ({ key, failure }) => `${key}${failure === undefined ? "" : " refused"}`
      )
      .join(",")}
  </output>
);

let host: HTMLElement | undefined;

const shownNow = (): string[] =>
  (host?.textContent ?? "").split(",").filter((each) => each !== "");

describe("the questions a tab sent", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    forgetSentQuestions();
  });

  it("holds a chat's next question while one is on its way, and keeps that one and a refused one as an answer ends", () => {
    host = document.createElement("div");
    const into = host;
    act(() => {
      root = createRoot(into);
      root.render(<Probe />);
    });
    act(() => {
      questionSent("chat-1", question("a"));
      sendBegan("chat-1", "a");
    });
    const whileOnItsWay = isSending("chat-1");
    act(() => {
      questionRefused("chat-1", "a", "Grasp can't be reached right now.");
      sendEnded("chat-1", "a");
      // Sent again, and another tab's answer in the chat ends meanwhile.
      questionSent("chat-1", question("a"));
      sendBegan("chat-1", "a");
      turnEnded("chat-1");
    });
    const afterAnswerEnded = shownNow();
    act(() => {
      sendEnded("chat-1", "a");
      turnEnded("chat-1");
    });

    expect({
      whileOnItsWay,
      afterAnswerEnded,
      taken: shownNow(),
      sending: isSending("chat-1"),
    }).toStrictEqual({
      whileOnItsWay: true,
      afterAnswerEnded: ["a"],
      taken: [],
      sending: false,
    });
  });
});
