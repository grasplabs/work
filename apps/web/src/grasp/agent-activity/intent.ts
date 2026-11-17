// When to use Agent activity, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A line showing what an agent is doing or did, which opens to list its steps.",
  useWhen: [
    { when: "What an agent is doing now and what it did, as steps." },
    { when: "One run of an agent: one Agent activity for each run." },
  ],
  notWhen: [
    { when: "Every token the agent streams: show steps, not logs." },
    {
      when: "The answer's own words as they arrive.",
      instead: ["chat-message", "markdown"],
      source: "docs/components/chat-message.mdx",
    },
    {
      when: "A file or a page loading, with no agent at work.",
      instead: ["spinner", "skeleton"],
      source: "docs/patterns/loading.mdx",
    },
    {
      when: "One line that says what an agent does, with no steps to open.",
      instead: ["text-shimmer"],
      proposed: true,
      note: "Text shimmer is that line, but a Working mark beside the words says the same, and nothing written chooses between them.",
    },
  ],
};
