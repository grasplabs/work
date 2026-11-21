// When to use Text shimmer, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A line of words that says what an agent is doing, with light passing across it.",
  useWhen: [
    {
      when: "A line that says what an agent is doing, while that step is really running: Thinking.",
    },
  ],
  notWhen: [
    { when: "A second shimmering line in the same view." },
    {
      when: "Content loading, not an agent working.",
      instead: ["skeleton", "spinner"],
      source: "docs/components/working-mark.mdx",
    },
    {
      when: "The agent's steps, what it did and what it is doing.",
      instead: ["agent-activity"],
      source: "docs/components/agent-activity.mdx",
    },
  ],
  variants: [
    {
      name: "active={false}",
      when: "The step has ended: plain words that say what happened, Thought for 12 seconds.",
    },
    {
      name: "wrap={false}",
      when: "Only where a place has room for one line and no more.",
    },
  ],
};
