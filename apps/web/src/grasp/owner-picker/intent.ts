// When to use Owner picker, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A field for choosing who owns something, found by typing their name or role.",
  useWhen: [
    {
      when: "Choosing the one person who owns something, found by their name or their role.",
    },
  ],
  notWhen: [
    {
      when: "A long list of things that are not people, to search.",
      instead: ["combobox"],
      source: "docs/components/combobox.mdx",
    },
    {
      when: "A handful of choices.",
      instead: ["select"],
      source: "docs/components/combobox.mdx",
    },
  ],
};
