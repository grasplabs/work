// When to use Table, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A table of facts in rows and columns, for people to compare at a glance.",
  useWhen: [
    { when: "Rows of facts in columns, to compare at a glance." },
    { when: "A few facts that never change.", proposed: true },
  ],
  notWhen: [
    {
      when: "A layout: rows of unlike things.",
      instead: ["item", "card"],
      source: "docs/patterns/tables.mdx",
    },
    {
      when: "Many rows that people search, choose or page through.",
      instead: ["data-table"],
      source: "docs/components/data-table.mdx",
    },
    {
      when: "Cells people edit, copy and paste as in a spreadsheet.",
      instead: ["data-grid"],
      source: "docs/components/data-grid.mdx",
    },
    { when: "A control in every cell: put one action at the row's end." },
  ],
};
