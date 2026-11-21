// When to use Breadcrumb, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A row of links showing the path to this page, so you can go back up.",
  useWhen: [
    { when: "The path from the top of a site down to the page you are on." },
    {
      when: "Above a page's title, in a page without an App shell.",
      source: "docs/components/page-header.mdx",
    },
  ],
  notWhen: [
    {
      when: "A top-level page: there is nowhere to lead back to.",
      source: "docs/patterns/navigation.mdx",
    },
    {
      when: "A page in an App shell: its crumbs stand in the page bar.",
      instead: ["app-shell"],
      source: "docs/components/page-header.mdx",
    },
    {
      when: "Views of one thing.",
      instead: ["tabs"],
      source: "docs/patterns/navigation.mdx",
    },
  ],
  variants: [
    {
      name: 'form="back"',
      when: "A header as narrow as a phone's: always the back link.",
    },
  ],
};
