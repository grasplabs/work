// When to use Card, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A box on the page that holds one thing and what belongs to it.",
  useWhen: [
    { when: "One thing and what belongs to it, on a surface of its own." },
    {
      when: "Unlike things side by side, each on its own card.",
      source: "docs/patterns/tables.mdx",
    },
  ],
  notWhen: [
    { when: "Inside another card." },
    {
      when: "Rows of like things to compare.",
      instead: ["table", "data-table"],
      source: "docs/components/table.mdx",
    },
    {
      when: "One part of a page, with its title, a sentence and its own buttons at the top.",
      instead: ["section-card"],
      source: "docs/components/section-card.mdx",
    },
    { when: "One big link with other controls inside it." },
  ],
  variants: [
    {
      name: 'ground="soft"',
      when: "A quiet panel set apart on a raised page.",
    },
    {
      name: 'padding="none"',
      when: "A table or a picture that runs to the edge.",
    },
    {
      name: "fill",
      when: "A cell of a fixed grid, a dashboard's: the card takes the cell's height and clips what does not fit.",
    },
  ],
};
