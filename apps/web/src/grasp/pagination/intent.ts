// When to use Pagination, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "Previous and Next buttons that page through a long list and show where you are.",
  useWhen: [
    {
      when: "A long list shown a page at a time, under the list and at its width.",
    },
  ],
  notWhen: [
    { when: "A list that never holds more than one page." },
    {
      when: "A table of many rows, which pages itself.",
      instead: ["data-table"],
      source: "docs/components/data-table.mdx",
    },
    {
      when: "The steps of a task, not the pages of a list.",
      instead: ["stepper", "multi-step-form"],
      source: "docs/patterns/navigation.mdx",
    },
  ],
  variants: [
    {
      name: 'show="range"',
      when: "The default: people need to know how much there is.",
    },
    { name: 'show="page"', when: "Where the range would say too much." },
    {
      name: 'show="none"',
      when: "Where the list already says how much it holds.",
    },
    {
      name: "getHref",
      when: "Each page is an address, so back, a reload and a new tab open it.",
    },
  ],
};
