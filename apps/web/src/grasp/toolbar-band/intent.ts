// When to use Toolbar band, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A row under a page's header with filters and a search for the list below.",
  useWhen: [
    {
      when: "Under a page's header: the kinds to browse at the start, a scope, a search and the page's action at the end.",
    },
  ],
  notWhen: [
    {
      when: "Nothing to browse or narrow yet.",
      source: "src/components/toolbar-band/toolbar-band.tsx",
    },
    {
      when: "The page's title and its main actions.",
      instead: ["page-header"],
      source: "docs/components/page-header.mdx",
    },
    {
      when: "Actions on the rows chosen in a table.",
      instead: ["data-table"],
      source: "docs/components/data-table.mdx",
    },
  ],
};
