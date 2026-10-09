import { describe, expect, it } from "vite-plus/test";

import { SIGN_FIGURES } from "./sign-figures.ts";
import { figureFor, signOf } from "./sign.ts";
import type { SignState } from "./sign.ts";

// What Grasp's sign shows while Grasp works on a question, and the figure
// it takes for it (sign.ts).

const step = (callId: string) => ({ callId, code: "return 1;" });
const nothingRan = () => false;

describe("what the sign shows", () => {
  it("reads the workspace before any answer shows", () => {
    expect(signOf({ partial: null, replies: [], ran: nothingRan })).toBe(
      "reading"
    );
  });

  it("follows what the answer being written shows: its words, or the code it writes", () => {
    expect(
      signOf({
        partial: { text: "So", code: [] },
        replies: [],
        ran: nothingRan,
      })
    ).toBe("writing");
    expect(
      signOf({
        partial: { text: "Let me look.", code: [step("a")] },
        replies: [],
        ran: nothingRan,
      })
    ).toBe("working");
    // Words that are not there yet are not being written.
    expect(
      signOf({
        partial: { text: " ", code: [] },
        replies: [{ code: [step("a")] }],
        ran: () => true,
      })
    ).toBe("thinking");
  });

  it("works while the code of its last answer runs, and thinks once it has the result", () => {
    const replies = [{ code: [step("a")] }];
    expect(signOf({ partial: null, replies, ran: nothingRan })).toBe("working");
    expect(
      signOf({ partial: null, replies, ran: (callId) => callId === "a" })
    ).toBe("thinking");
    expect(
      signOf({ partial: null, replies: [{ code: [] }], ran: nothingRan })
    ).toBe("thinking");
  });
});

describe("the figure for what Grasp is doing", () => {
  it("is the brain while it reads the workspace and thinks", () => {
    expect(figureFor("reading")).toBe("brain");
    expect(figureFor("thinking")).toBe("brain");
  });

  it("is the lines of a document while it reads one, and only then", () => {
    expect(figureFor("reading", { document: true })).toBe("lines");
    expect(figureFor("thinking", { document: true })).toBe("brain");
  });

  it("is a pen, a workflow and an exclamation mark for writing, working and failing", () => {
    expect(figureFor("writing")).toBe("pen");
    expect(figureFor("working")).toBe("flow");
    expect(figureFor("error")).toBe("alert");
  });

  it("is always one of the figures the sign has", () => {
    const states: SignState[] = [
      "reading",
      "thinking",
      "writing",
      "working",
      "error",
    ];
    for (const state of states) {
      for (const document of [false, true]) {
        expect(SIGN_FIGURES).toContain(figureFor(state, { document }));
      }
    }
  });
});
