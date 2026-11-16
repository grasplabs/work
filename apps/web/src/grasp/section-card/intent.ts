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
  ],
};
