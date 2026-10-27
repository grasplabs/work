import { describe, expect, it } from "vite-plus/test";

import { SIGN_FIGURES } from "./sign-figures.ts";
import { figureFor, readingFileOf, signOf } from "./sign.ts";
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

/** A call of step `callId`'s code, as the chat shows it. */
const call = (
  callId: string,
  method: string,
  target: { type: string; id: string } | null,
  outcome: "ok" | "refused" = "ok"
) => ({
  id: 1,
  callId,
  method,
  target,
  summary: {},
  outcome,
  reason: null,
  at: "2026-10-27T08:00:02.000Z",
});

describe("the file Grasp reads", () => {
  const plan = {
    id: "file-plan",
    name: "plan.md",
    type: "md" as const,
    bytes: 20,
    createdAt: "2026-10-27T08:00:00.000Z",
  };
  const question = {
    id: 1,
    role: "user" as const,
    text: "Read the plan.",
    at: "2026-10-27T08:00:01.000Z",
  };
  const messages = [{ ...question, files: [plan] }];
  const read = call("a", "chat.readFile", { type: "chat_file", id: plan.id });

  it("is the file the running step's code read, by the name its question shows", () => {
    expect(
      readingFileOf({
        doing: "working",
        step: step("a"),
        tools: [read],
        messages,
      })
    ).toBe("plan.md");
  });

  it("is none while Grasp does anything else, or the step read no file of the chat's", () => {
    expect({
      thinking: readingFileOf({
        doing: "thinking",
        step: step("a"),
        tools: [read],
        messages,
      }),
      anotherStep: readingFileOf({
        doing: "working",
        step: step("b"),
        tools: [read],
        messages,
      }),
      refused: readingFileOf({
        doing: "working",
        step: step("a"),
        tools: [
          call(
            "a",
            "chat.readFile",
            { type: "chat_file", id: plan.id },
            "refused"
          ),
        ],
        messages,
      }),
      otherCall: readingFileOf({
        doing: "working",
        step: step("a"),
        tools: [call("a", "knowledge.read", { type: "document", id: plan.id })],
        messages,
      }),
      unknownFile: readingFileOf({
        doing: "working",
        step: step("a"),
        tools: [read],
        messages: [{ ...question, files: [] }],
      }),
    }).toStrictEqual({
      thinking: undefined,
      anotherStep: undefined,
      refused: undefined,
      otherCall: undefined,
      unknownFile: undefined,
    });
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
