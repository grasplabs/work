// When to use Brand icons, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "Another company's logo, shown for an integration, a source or a way to sign in.",
  useWhen: [
    {
      when: "Another company's mark: an integration, a source, a way to sign in.",
    },
  ],
  notWhen: [
    {
      when: "A person or a team.",
      instead: ["avatar"],
      source: "docs/components/avatar.mdx",
    },
  ],
  variants: [
    {
      name: "tile={false}",
      when: "The mark alone, beside words, as in a button.",
    },
    {
      name: 'tone="mono"',
      when: "The same shape in the text colour, where the brand's colours would be too loud.",
    },
    {
      name: "decorative",
      when: "The brand's name is already in the words beside it.",
    },
  ],
};
