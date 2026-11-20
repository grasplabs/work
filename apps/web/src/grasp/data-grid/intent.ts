// When to use Data grid, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A spreadsheet in the page, where people edit cells in place and copy and paste.",
  useWhen: [
    {
      when: "People edit values in place, cell by cell, and copy and paste with a spreadsheet.",
    },
  ],
  notWhen: [
    {
      when: "Rows to read, sort, search and act on, not to edit.",
      instead: ["data-table"],
      source: "docs/components/data-table.mdx",
    },
    {
      when: "A few facts that never change.",
      instead: ["table"],
      proposed: true,
    },
  ],
  variants: [
    {
      name: 'tab="move"',
      when: "The default: Tab steps cell to cell, as a spreadsheet's does.",
    },
    {
      name: 'tab="leave"',
      when: "The grid is one stop among the page's controls: Tab leaves it at once.",
    },
  ],
};
