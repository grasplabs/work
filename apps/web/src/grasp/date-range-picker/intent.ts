// When to use Date range picker, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A field for two dates, a start and an end, with ranges like Last 7 days.",
  useWhen: [
    {
      when: "A period, with presets for the ranges the product reports on most.",
    },
    {
      when: "A range of what has happened, with `max` of today so it cannot run into the future.",
    },
  ],
  notWhen: [
    {
      when: "One date.",
      instead: ["date-picker"],
      source: "docs/components/date-picker.mdx",
    },
    { when: "A start and an end as two separate pickers." },
  ],
  variants: [
    { name: "presets", when: "The ranges the product reports on, by name." },
    {
      name: "presets={false}",
      when: "Ranges that are one-off: people choose each on the calendar.",
    },
  ],
};
