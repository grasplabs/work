// When to use Section header, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A heading for one part of a page, with a sentence and that part's actions.",
  useWhen: [
    {
      when: "The title of a part of a page, with actions that act on that part only.",
    },
  ],
  notWhen: [
    {
      when: "The page's own title.",
      instead: ["page-header"],
      source: "docs/components/page-header.mdx",
    },
    {
      when: "More than two actions: put the rest in a menu.",
      instead: ["dropdown-menu"],
    },
    {
      when: "A part of a page that stands on a card of its own.",
      instead: ["section-card"],
      source: "docs/components/section-card.mdx",
    },
    {
      when: "A title alone, with no sentence and no actions.",
      instead: ["heading"],
      source: "docs/components/heading.mdx",
    },
  ],
  variants: [
    {
      name: 'size="sm"',
      when: "The head of a dense card: title and sentence at text-sm (Section card's compact density).",
    },
  ],
};
