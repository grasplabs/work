import type { ChatMessage } from "@grasp-os/shared/chat";
import { i18n } from "@lingui/core";
import { describe, expect, it } from "vite-plus/test";

import { chatMarkdown, plainText } from "./chat-markdown.ts";

// What an exported chat holds: its questions as typed, its answers with
// how each ended, and its sources, and nothing of the code steps it ran.

const at = "2026-10-04T10:00:00.000Z";

const asked = (id: number, text: string): ChatMessage => ({
  id,
  role: "user",
  text,
  at,
});

const answered = (
  id: number,
  text: string,
  end: "done" | "cut_off" | "cancelled" | "failed" = "done",
  error?: string
): ChatMessage => ({
  id,
  role: "assistant",
  text,
  code: [],
  end,
  at,
  ...(error === undefined ? {} : { error }),
});

const none = { sources: [], restricted: false };

describe(chatMarkdown, () => {
  it("writes the title, each question and answer under who said it, and the sources by name", () => {
    expect(
      chatMarkdown({
        title: "Open invoices",
        messages: [
          asked(1, "How many invoices are open?"),
          {
            id: 2,
            role: "assistant",
            text: "",
            code: [{ callId: "c1", code: "count()" }],
            end: "done",
            at,
          },
          {
            id: 3,
            role: "result",
            callId: "c1",
            text: "12",
            failed: false,
            at,
          },
          answered(4, "| Open |\n| --- |\n| 12 |"),
        ],
        provenance: { sources: ["col-1", "conn-9"], restricted: false },
        names: new Map([
          ["col-1", { name: "Finance", kind: "collection" as const }],
        ]),
        i18n,
      })
    ).toBe(
      [
        "# Open invoices",
        "**You:**\n\nHow many invoices are open?",
        // An answer that opens with a table keeps it a table.
        "**Grasp:**\n\n| Open |\n| --- |\n| 12 |",
        "## Sources",
        "- Finance\n- conn-9",
      ].join("\n\n")
    );
  });

  it("says how an answer ended when it didn't finish, and marks a restricted chat", () => {
    expect(
      chatMarkdown({
        title: "Pay",
        messages: [
          asked(1, "a"),
          answered(2, "", "failed"),
          asked(3, "b"),
          answered(4, "Half", "cut_off"),
          asked(5, "c"),
          answered(6, "", "cancelled"),
          asked(7, "d"),
          answered(8, "", "failed", "The budget is spent."),
        ],
        provenance: { sources: [], restricted: true },
        names: new Map(),
        i18n,
      })
    ).toBe(
      [
        "# Pay",
        "**You:**\n\na",
        "**Grasp:**\n\nThe model call failed.",
        "**You:**\n\nb",
        "**Grasp:**\n\nHalf\n\nThe answer was cut off at the model's limit.",
        "**You:**\n\nc",
        "**Grasp:**\n\nStopped.",
        "**You:**\n\nd",
        "**Grasp:**\n\nThe budget is spent.",
        "## Sources",
        "**Restricted**",
      ].join("\n\n")
    );
  });

  it("includes the answer being written, as far as it has come", () => {
    expect(
      chatMarkdown({
        title: "Hello",
        messages: [asked(1, "Hi")],
        partial: { text: "Hello the", code: [] },
        provenance: none,
        names: new Map(),
        i18n,
      })
    ).toBe("# Hello\n\n**You:**\n\nHi\n\n**Grasp:**\n\nHello the");
  });

  it("leaves the sources out when the answers drew on none", () => {
    expect(
      chatMarkdown({
        title: "Hello",
        messages: [asked(1, "Hi")],
        provenance: none,
        names: new Map(),
        i18n,
      })
    ).toBe("# Hello\n\n**You:**\n\nHi");
  });
});

describe(plainText, () => {
  it("keeps what someone typed from being read as Markdown, line breaks and all", () => {
    expect(plainText("# Not a heading\n- not a list\n*not bold* a|b")).toBe(
      String.raw`\# Not a heading\
\- not a list\
\*not bold\* a\|b`
    );
  });
});
