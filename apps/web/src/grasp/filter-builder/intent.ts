// When to use Filter builder, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A control that builds one filter rule from a field, an operator and a value.",
  useWhen: [
    {
      when: "One condition that narrows a list: a field, an operator and a value.",
    },
  ],
  notWhen: [
    {
      when: "Filtering the rows of a data table.",
      instead: ["data-table"],
      source: "docs/components/data-table.mdx",
    },
    {
      when: "One value chosen from a list, with no operator.",
      instead: ["select"],
      proposed: true,
    },
  ],
};
