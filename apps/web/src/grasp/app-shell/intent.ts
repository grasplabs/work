// When to use App shell, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "The frame every page of an app sits in, with its main navigation beside the page.",
  useWhen: [
    {
      when: "The frame every page of a product stands in, with its main navigation beside it.",
    },
  ],
  notWhen: [
    {
      when: "A page's title row, with its actions and its tabs.",
      instead: ["page-header"],
      source: "docs/components/page-header.mdx",
    },
    {
      when: "The main navigation alone, without the frame.",
      instead: ["sidebar"],
    },
    {
      when: "Details of one thing beside the page.",
      instead: ["panel", "sheet"],
      source: "docs/components/sheet.mdx",
    },
  ],
  variants: [
    {
      name: 'bar="frame"',
      when: "The default: the shell draws the page bar from the crumbs and the actions.",
    },
    {
      name: 'bar="page"',
      when: "Each page draws its own bar, with its own crumbs and actions.",
    },
    {
      name: 'bar="none"',
      when: "The page has the whole card, such as a backdrop.",
    },
    {
      name: "sidebar={false}",
      when: "A page with no navigation, such as a start page.",
    },
    {
      name: 'roomBelow="chat"',
      when: "A chat box floats over the page's foot.",
    },
  ],
};
