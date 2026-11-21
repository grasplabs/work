// When to use Toolbar band, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "Now PageHeader's toolbar: a row under a page's header with filters and a search for the list below.",
  useWhen: [
    {
      when: "Only where it is used already, until the codemod moves it: it stays for one step so nothing breaks.",
      source: "docs/components/toolbar-band.mdx",
    },
  ],
  notWhen: [
    {
      when: "Any new use: a PageHeaderToolbar, given as the PageHeader's `toolbar`.",
      instead: ["page-header"],
      source: "docs/components/page-header.mdx",
    },
  ],
};
