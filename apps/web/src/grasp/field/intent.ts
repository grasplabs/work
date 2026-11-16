// When to use Field, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A control with its label, its description and the error it shows.",
  useWhen: [
    {
      when: "One control in a form, with its label, a line of help and its error.",
      source: "docs/components/input.mdx",
    },
  ],
  notWhen: [
    {
      when: "A control outside a Field that only needs its name.",
      instead: ["label"],
      source: "docs/components/input.mdx",
    },
    {
      when: "The layout of a whole form, its groups and its buttons.",
      instead: ["form"],
      source: "docs/components/form.mdx",
    },
  ],
  variants: [
    {
      name: "invalid",
      when: "An error your code decides, such as the server saying no: shown at once.",
    },
  ],
};
