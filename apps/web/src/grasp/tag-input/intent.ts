// When to use Tag input, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A box where you type several values, like labels, each shown as a tag.",
  useWhen: [
    {
      when: "Several values typed into one field, such as labels, with suggestions or without.",
    },
  ],
  notWhen: [
    {
      when: "One value chosen from a long list.",
      instead: ["combobox"],
      source: "docs/components/combobox.mdx",
    },
    {
      when: "One line of free text.",
      instead: ["input"],
      source: "docs/components/input.mdx",
    },
    {
      when: "A few fixed choices, several of them at once.",
      instead: ["checkbox"],
      source: "docs/components/checkbox.mdx",
    },
  ],
};
