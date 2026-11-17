// When to use Panel, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A panel beside a page that shows the details of one thing, in sections.",
  useWhen: [
    {
      when: "The details of one thing in an inspector, beside its page on a wide screen.",
      source: "docs/patterns/inspector.mdx",
    },
  ],
  notWhen: [
    {
      when: "A phone, with no room beside the page: put it in a Sheet.",
      instead: ["sheet"],
    },
    {
      when: "What a thing is and what it is made of, drawn from data.",
      instead: ["inspector-panel"],
      source: "docs/components/inspector-panel.mdx",
    },
  ],
  variants: [
    {
      name: "framed={false}",
      when: "Inside a Sheet, which draws its own ground.",
    },
  ],
};
