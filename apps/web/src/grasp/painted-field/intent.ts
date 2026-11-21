// When to use Painted field, and when not: its page, its Markdown twin, its registry item and the
// MCP server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "The brand's painted field: a painting, a grain and white lines, for the one or two things on a page that matter most.",
  useWhen: [
    {
      when: "A band across the top of a page about one thing, such as Integrations.",
    },
  ],
  notWhen: [
    { when: "A whole page's scene behind everything.", instead: ["backdrop"] },
    {
      when: "A faint light behind the head of one object.",
      instead: ["panel"],
    },
  ],
  variants: [
    { name: "mist", when: "The painting: a cool grey blue, tide in the dark." },
    {
      name: "horizon",
      when: "The lines: three wide columns, the middle lit, and a horizon.",
    },
    { name: "band", when: "The shape: a band across the top of a page." },
  ],
};
