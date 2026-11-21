// When to use Chart, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A chart of numbers across kinds, over time, as parts of a whole or as flows between stages: bars, bars across, an area, lines, a ring a Sankey or a spark.",
  useWhen: [
    { when: "Numbers over time or across kinds, as bars or an area." },
    { when: "A trend over time, as a line alone." },
    {
      when: "Two to five trends compared, or this period against last: several lines, each named at its end (ChartLabels).",
    },
    {
      when: "Two to five parts of one whole, or one share of a target, with the total in words: a ring (ChartRing).",
    },
    {
      when: "A trend beside its number, in a table cell or under a highlight's figure: a spark (ChartSpark).",
    },
    {
      when: "How a whole moves between stages (invoices received, matched, approved, paid): flows as ribbons (ChartSankey).",
    },
    {
      when: "Kinds ranked by how much, with names too long for the bottom of a chart: bars across (ChartBarList).",
    },
  ],
  notWhen: [
    {
      when: "A few figures that matter, each with how it moved.",
      instead: ["highlights"],
      source: "docs/components/highlights.mdx",
    },
    {
      when: "Exact numbers people look up or compare one by one.",
      instead: ["table"],
      source: "docs/components/table.mdx",
    },
    {
      when: "More than five parts of a whole, or the same parts compared month by month: a ring cannot hold them.",
      instead: ["table"],
    },
    {
      when: "More than five lines at once: they can no longer be told apart without colour.",
      instead: ["table"],
    },
  ],
};
