// When to use Language switch, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A control for choosing the product's language, each shown by its own name and flag.",
  useWhen: [{ when: "A person chooses the language the product speaks." }],
  notWhen: [
    {
      when: "Any other value chosen from a list.",
      instead: ["select", "combobox"],
      source: "docs/components/select.mdx",
    },
    {
      when: "Light or dark.",
      instead: ["theme-switch"],
      source: "docs/components/theme-switch.mdx",
    },
  ],
  variants: [
    { name: 'look="compact"', when: "The default: in a header or a footer." },
    { name: 'look="list"', when: "On a settings page." },
    { name: 'look="pair"', when: "Exactly two languages." },
  ],
};
