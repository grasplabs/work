// When to use Chat message, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "One message in a chat with an assistant, from the person or the agent.",
  useWhen: [
    {
      when: "One message in a conversation with an assistant, a person's or the agent's.",
    },
  ],
  notWhen: [
    {
      when: "The list that holds the whole conversation.",
      instead: ["thread"],
      source: "docs/components/thread.mdx",
    },
    {
      when: "Where the person writes to the assistant.",
      instead: ["composer"],
      source: "docs/components/composer.mdx",
    },
    {
      when: "The agent's steps while it works.",
      instead: ["agent-activity"],
      source: "docs/components/agent-activity.mdx",
    },
  ],
  variants: [
    {
      name: 'status="thinking"',
      when: "The agent works and has not begun to write.",
    },
    {
      name: 'status="streaming"',
      when: "The agent's answer is being written.",
    },
    {
      name: 'status="done"',
      when: "The answer is written, and every person's message: the default.",
    },
    { name: 'status="failed"', when: "The answer could not be written." },
    {
      name: "streamingMark",
      when: "A working mark under the words while they arrive. Off by default.",
    },
  ],
};
