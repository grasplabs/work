// When to use Page header, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "The top of a page, with its title, a line about it, its actions and tabs.",
  useWhen: [
    {
      when: "The top of a page: its title, one line on what it holds, its actions and its tabs.",
    },
    {
      when: "A list under the header to browse and narrow: its `toolbar`, the kinds to browse at the start, a scope, a search and the page's action at the end.",
    },
  ],
  notWhen: [
    {
      when: "A toolbar with nothing to browse or narrow yet.",
      source: "src/components/page-header/toolbar.tsx",
    },
    {
      when: "Actions on the rows chosen in a table.",
      instead: ["data-table"],
      source: "docs/components/data-table.mdx",
    },
    {
      when: "The title of a part of a page.",
      instead: ["section-header"],
      source: "docs/components/section-header.mdx",
    },
    {
      when: "The page's crumbs in an App shell: they stand in its page bar.",
      instead: ["app-shell"],
    },
  ],
  variants: [
    {
      name: "toolbar",
      when: "A PageHeaderToolbar under the title: what changes the list below.",
    },
    {
      name: 'size="sm"',
      when: "A sub-page whose crumbs say where you are (a settings page): a smaller title in the sans, no lead.",
    },
  ],
};
