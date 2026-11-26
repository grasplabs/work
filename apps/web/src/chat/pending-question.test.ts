import type { ChatMessage } from "@grasp-os/shared/chat";
import { describe, expect, it } from "vite-plus/test";

import { shownPending } from "./pending-question.ts";
import type { PendingQuestion } from "./pending-question.ts";

// The question on its way, drawn until core's copy of it comes. These
// start from the ways it could go wrong: drawn twice once core's copy is
// there, gone before it is, or still drawn once it failed and went back
// into the box.

const at = "2026-11-26T09:00:00.000Z";

const asked = (id: number, text: string): ChatMessage => ({
  id,
  role: "user",
  text,
  at,
});

const pending: PendingQuestion = {
  text: "Yes",
  mentions: [],
  files: [],
  after: 2,
  at,
  failed: false,
};

describe("the question on its way", () => {
  it("is drawn until core's copy comes, even when an earlier question had the same words", () => {
    const before = [asked(1, "Yes"), asked(2, "Done?")];

    expect({
      waiting: shownPending(pending, before),
      taken: shownPending(pending, [...before, asked(3, "Yes")]),
    }).toStrictEqual({ waiting: pending, taken: undefined });
  });

  it("is not drawn once it failed and went back into the box", () => {
    expect(shownPending({ ...pending, failed: true }, [])).toBeUndefined();
  });
});
