// When to use Date picker, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A field for a date, typed in or chosen from a calendar it opens.",
  useWhen: [
    { when: "One date in a form, typed or chosen on a calendar." },
    { when: "A range, as one picker in range mode, never two pickers." },
    {
      when: "A range of what has happened, with presets and `max` of today so it cannot run into the future.",
    },
  ],
  notWhen: [
    {
      when: "A date far back, such as a birthday: let people type it.",
      instead: ["input"],
      proposed: true,
    },
    {
      when: "A month always in view on the page.",
      instead: ["calendar"],
      source: "docs/components/calendar.mdx",
    },
  ],
  variants: [
    { name: 'mode="range"', when: "A start and an end, in one picker." },
    {
      name: "presets",
      when: "A range people report on: Today, Last 7 days, or the product's own ranges by name.",
    },
    { name: 'size="sm"', when: "In a dense table or toolbar.", proposed: true },
    {
      name: 'size="lg"',
      when: "The one field that matters on a phone.",
      proposed: true,
    },
  ],
};
