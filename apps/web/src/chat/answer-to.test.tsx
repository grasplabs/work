// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useAnswerTo } from "./answer-to.ts";

// Which question Grasp UI's Thread keeps room under for its answer: the
// one asked in this view, from the moment it runs until the next is asked
// or the chat is left; none in a chat opened with no question running.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;
let seen: (string | undefined)[] = [];

const Probe = (props: {
  chatId: string;
  lastQuestion: string | undefined;
  running: boolean;
}) => {
  seen.push(useAnswerTo(props.chatId, props.lastQuestion, props.running));
  return null;
};

/** The chat as it goes, step by step: what each step keeps room under. */
const through = (
  steps: { chatId: string; lastQuestion?: string; running: boolean }[]
): (string | undefined)[] => {
  const host = document.createElement("div");
  root = createRoot(host);
  return steps.map((step) => {
    seen = [];
    act(() => {
      root?.render(
        <Probe
          chatId={step.chatId}
          lastQuestion={step.lastQuestion}
          running={step.running}
        />
      );
    });
    return seen.at(-1);
  });
};

describe("the question room is kept under", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
  });

  it("keeps the question asked here once its answer ended, until the next is asked", () => {
    expect(
      through([
        { chatId: "a", lastQuestion: "q1", running: true },
        { chatId: "a", lastQuestion: "q1", running: false },
        { chatId: "a", lastQuestion: "q2", running: true },
        { chatId: "a", lastQuestion: "q2", running: false },
      ])
    ).toStrictEqual(["q1", "q1", "q2", "q2"]);
  });

  it("keeps none in a chat opened with no question running, nor in another chat once left", () => {
    expect(
      through([
        { chatId: "a", lastQuestion: "q1", running: false },
        { chatId: "a", lastQuestion: "q2", running: true },
        { chatId: "b", lastQuestion: "q9", running: false },
      ])
    ).toStrictEqual([undefined, "q2", undefined]);
  });
});
