// When to use Copy field, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A value you can copy, shown whole on one line with a copy button at its end.",
  useWhen: [
    {
      when: "A value someone copies to use elsewhere: an install command, an id, a key, a token's name or value.",
    },
  ],
  notWhen: [
    {
      when: "Code of more than one line, or code to read.",
      instead: ["code-block"],
      source: "docs/components/code-block.mdx",
    },
    {
      when: "A fact with its name, where copying is a side action.",
      instead: ["key-value"],
      source: "docs/components/key-value.mdx",
    },
    {
      when: "Copying something larger than what is shown (a message, a page): a Copy button.",
    },
  ],
};
