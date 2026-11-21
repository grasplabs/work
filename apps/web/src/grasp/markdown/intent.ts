// When to use Markdown, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "An agent's answer in Markdown, shown as formatted text, even while it is still arriving.",
  useWhen: [
    {
      when: "An agent's answer written in Markdown, finished or still arriving.",
    },
    {
      when: "An agent's words in a card or a panel: its instructions, a note.",
    },
  ],
  notWhen: [
    {
      when: "The whole message, with who sent it and what can be done to it.",
      instead: ["chat-message"],
      source: "src/components/markdown/markdown.tsx",
    },
    {
      when: "Code on its own, to read or copy.",
      instead: ["code-block"],
      source: "docs/components/code-block.mdx",
    },
    {
      when: "The interface's own words, which are no agent's answer.",
      instead: ["text"],
      proposed: true,
    },
  ],
  variants: [
    { name: "streaming", when: "The answer is still being written." },
    { name: 'size="md"', when: "The default: an answer in a thread." },
    {
      name: 'size="sm"',
      when: "Words in a card or a panel: an agent's instructions, a note.",
    },
    {
      name: "renderLink",
      when: "The answer may hold links from untrusted text: the host draws each one, asking before it leaves, or as a claim.",
    },
  ],
};
