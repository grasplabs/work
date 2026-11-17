// When to use Data table, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A table of rows that people can sort, search, select and page through.",
  useWhen: [
    { when: "Rows people sort, search, choose and page through." },
    { when: "A list that runs past a screen, in pages with `pageSize`." },
  ],
  notWhen: [
    { when: "A few facts that never change.", instead: ["table"] },
    {
      when: "Values edited in place, cell by cell, as in a spreadsheet.",
      instead: ["data-grid"],
      source: "docs/components/data-grid.mdx",
    },
    {
      when: "A card's short list of things, one line each.",
      instead: ["row-list"],
      source: "docs/components/row-list.mdx",
    },
  ],
  variants: [
    { name: "searchable", when: "People find rows by the words in them." },
    {
      name: "selectable",
      when: "People act on several rows at once, from a bar above.",
    },
    {
      name: "filterable",
      when: "One condition narrows the rows: a column, an operator and a value.",
    },
  ],
};
