// @vitest-environment happy-dom
import type { ChatMessage } from "@grasp-os/shared/chat";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";

import { shownPending, takesBack, useBoxOwner } from "./pending-question.ts";
import type { PendingQuestion } from "./pending-question.ts";

// The question on its way, drawn until core's copy of it comes, and taken
// back into a box if it fails. These start from the ways it could go
// wrong: drawn twice once core's copy is there, gone before it is, still
// drawn once it failed; taken back by two boxes at once, by none once the
// box that sent it is gone, or into the box when it wasn't the person's.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const at = "2026-11-26T09:00:00.000Z";

const asked = (id: number, text: string, key?: string): ChatMessage => ({
  id,
  role: "user",
  text,
  ...(key === undefined ? {} : { key }),
  at,
});

const pending: PendingQuestion = {
  text: "Yes",
  mentions: [],
  files: [],
  at,
  queues: false,
  alreadyQueued: 0,
  key: "key-1",
  owner: "start",
  fromBox: true,
  state: "sending",
};

const refused: PendingQuestion = {
  ...pending,
  state: { failed: "The chat is full." },
};

/** A box, which says its owner ID. */
const Box = () => <span data-owner={useBoxOwner()} />;

/** A box on the page, as it says its owner ID; and what takes it off. */
const boxOnPage = () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => {
    root.render(<Box />);
  });
  return {
    owner: host.querySelector("span")?.dataset.owner ?? "",
    leave: () => {
      act(() => {
        root.unmount();
      });
    },
  };
};

describe("the question on its way", () => {
  it("is drawn until core's copy comes, even when an earlier question had the same words", () => {
    const before = [asked(1, "Yes"), asked(2, "Done?")];

    expect({
      waiting: shownPending(pending, before),
      taken: shownPending({ ...pending, state: "sent" }, [
        ...before,
        asked(3, "Yes", "key-1"),
      ]),
      refused: shownPending(refused, before),
    }).toStrictEqual({
      waiting: pending,
      taken: undefined,
      refused: undefined,
    });
  });

  it("sent in the words of a question queued already, is drawn until core queues it too", () => {
    const again = { ...pending, queues: true, alreadyQueued: 1 };
    const older = { id: "7", text: "Yes" };

    expect({
      older: shownPending(again, [], [older]),
      both: shownPending(again, [], [older, { id: "8", text: "Yes" }]),
    }).toStrictEqual({ older: again, both: undefined });
  });

  it("stays put while an older queued question is taken and kept, and goes only once core keeps it under its own key", () => {
    const before = [asked(1, "Yes"), asked(2, "Done?")];
    // An older question, queued behind an answer, is taken and kept while
    // this one is still on its way (its file uploading).
    const older = asked(3, "And the totals?", "key-0");
    // The same words asked meanwhile from another tab, under its own key.
    const otherTab = asked(4, "Yes", "key-2");
    const own = asked(5, "Yes", "key-1");

    expect({
      olderTaken: shownPending(pending, [...before, older]),
      otherTab: shownPending(pending, [...before, older, otherTab]),
      ownKept: shownPending(pending, [...before, older, otherTab, own]),
    }).toStrictEqual({
      olderTaken: pending,
      otherTab: pending,
      ownKept: undefined,
    });
  });

  it("is taken back by the box that sent it while it is on the page, and by the box showing its chat once it is gone", () => {
    const start = boxOnPage();
    const question = { ...refused, owner: start.owner };
    const whileThere = {
      sender: takesBack(question, start.owner, true),
      chatPage: takesBack(question, "chat-page", true),
    };
    start.leave();

    expect({
      whileThere,
      gone: takesBack(question, "chat-page", false),
      onItsWay: takesBack({ ...pending, owner: "gone" }, "chat-page", false),
      askedForThePerson: takesBack(
        { ...refused, owner: "gone", fromBox: false },
        "chat-page",
        false
      ),
    }).toStrictEqual({
      whileThere: { sender: true, chatPage: false },
      gone: true,
      onItsWay: false,
      askedForThePerson: false,
    });
  });
});
