import type { ChatMessage } from "@grasp-os/shared/chat";
import { i18n } from "@lingui/core";
import { describe, expect, it } from "vite-plus/test";

import { chatMarkdown } from "./chat-markdown.ts";

// What an exported chat holds: its questions, answers and sources, and
// nothing of the code steps it ran.

const at = "2026-10-04T10:00:00.000Z";

const messages: ChatMessage[] = [
  { id: 1, role: "user", text: "How many invoices are open?", at },
  {
    id: 2,
    role: "assistant",
    text: "",
    code: [{ callId: "c1", code: "count()" }],
    end: "done",
    at,
  },
  { id: 3, role: "result", callId: "c1", text: "12", failed: false, at },
  {
    id: 4,
    role: "assistant",
    text: "**12** invoices are open.",
    code: [],
    end: "done",
    at,
  },
];

describe(chatMarkdown, () => {
  it("writes the title, each question and answer, and the sources by name", () => {
    expect(
      chatMarkdown({
        title: "Open invoices",
        messages,
        provenance: { sources: ["col-1", "conn-9"], restricted: false },
        names: new Map([
          ["col-1", { name: "Finance", kind: "collection" as const }],
        ]),
        i18n,
      })
    ).toBe(
      [
        "# Open invoices",
        "**You:** How many invoices are open?",
        "**Grasp:** **12** invoices are open.",
        "## Sources\n\n- Finance\n- conn-9",
      ].join("\n\n")
    );
  });

  it("leaves the sources out when the answers drew on none", () => {
    expect(
      chatMarkdown({
        title: "Hello",
        messages: messages.slice(0, 1),
        provenance: { sources: [], restricted: false },
        names: new Map(),
        i18n,
      })
    ).toBe("# Hello\n\n**You:** How many invoices are open?");
  });
});
