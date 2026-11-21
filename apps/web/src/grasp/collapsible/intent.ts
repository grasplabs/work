// When to use Collapsible, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A section that opens and closes from a button, for detail most people can skip.",
  useWhen: [
    { when: "Detail most people can skip, in one panel under its trigger." },
    {
      when: "The rarely changed settings, at the foot of an inspector.",
      source: "docs/patterns/inspector.mdx",
    },
  ],
  notWhen: [
    { when: "Opening one should close the others.", instead: ["accordion"] },
    { when: "A single short sentence." },
    { when: "The only way to finish a task." },
  ],
  variants: [
    { name: 'variant="raised"', when: "Panels that stand on their own." },
    { name: "fit", when: "One quiet line that opens, among words." },
  ],
};
