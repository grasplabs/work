// When to use Date range picker, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "Now Date picker's range with presets: a field for two dates, with ranges like Last 7 days.",
  useWhen: [
    {
      when: "Only where it is used already, until the codemod moves it: it stays for one step so nothing breaks.",
      source: "docs/components/date-range-picker.mdx",
    },
  ],
  notWhen: [
    {
      when: "A range, with or without presets.",
      instead: ["date-picker"],
      source: "docs/components/date-picker.mdx",
    },
  ],
};
