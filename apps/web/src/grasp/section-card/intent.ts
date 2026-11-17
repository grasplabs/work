// When to use Section card, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A card for one part of a page, with a title, a sentence and its buttons.",
  useWhen: [
    { when: "One part of a page on a card, with its own buttons at the top." },
  ],
  notWhen: [
    { when: "Inside a card.", instead: ["section-header"], proposed: true },
    {
      when: "The page's own buttons.",
      instead: ["page-header"],
      source: "docs/components/page-header.mdx",
    },
    {
      when: "A section of an inspector.",
      instead: ["panel-section"],
      source: "docs/components/panel-section.mdx",
    },
  ],
  variants: [
    {
      name: "flush",
      when: "A table or a list, so its rows reach the card's edges.",
    },
    {
      name: 'density="compact"',
      when: "A settings card, or another dense one: the head at text-sm with less room.",
    },
    {
      name: "fill",
      when: "A widget in a dashboard's fixed grid cell: its body stretches to the foot, clips, and fades while there is more.",
    },
    {
      name: "handle",
      when: "A widget a person drags on a board: the title row is the handle; the host does the drag and the keys.",
    },
  ],
};
