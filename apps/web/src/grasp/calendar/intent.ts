// When to use Calendar, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A month of days on the page, for choosing a date, several dates or a range.",
  useWhen: [
    {
      when: "Choosing a date, several dates or a range, with the month always in view.",
    },
  ],
  notWhen: [
    {
      when: "Typing a known date, such as a birthday.",
      instead: ["date-picker"],
    },
    {
      when: "A date in a form's field, with the month opened only when asked.",
      instead: ["date-picker"],
      source: "docs/components/date-picker.mdx",
    },
    {
      when: "A start and an end date, with the ranges people use most.",
      instead: ["date-range-picker"],
      source: "docs/components/date-range-picker.mdx",
    },
  ],
  variants: [
    { name: 'mode="single"', when: "One date: the default." },
    { name: 'mode="multiple"', when: "Any number of days." },
    {
      name: 'mode="range"',
      when: "A start and an end, with two months side by side.",
    },
  ],
};
