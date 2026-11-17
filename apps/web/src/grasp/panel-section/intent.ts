// When to use Panel section, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "One section of a side panel, with a short label, one action and one card.",
  useWhen: [
    {
      when: "One section of an inspector: a short label, one action and one card.",
    },
  ],
  notWhen: [
    {
      when: "What is rarely changed, at the foot of the inspector.",
      instead: ["collapsible"],
      source: "docs/patterns/inspector.mdx",
    },
    {
      when: "A part of a page, outside an inspector.",
      instead: ["section-card", "section-header"],
      source: "docs/components/section-card.mdx",
    },
  ],
};
