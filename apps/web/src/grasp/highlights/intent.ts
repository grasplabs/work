// When to use Highlights, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A row of key figures, each with its name and how much it changed.",
  useWhen: [
    { when: "The figures a person checks first, at most four in a row." },
  ],
  notWhen: [
    { when: "A chart: put it on its own.", instead: ["chart"] },
    { when: "Something to press or follow." },
    {
      when: "Facts about one thing, each a name over its value.",
      instead: ["key-value"],
      proposed: true,
      note: "Key value is for plain facts, but Highlights also shows a name over its value, so figures about one thing could go either way unless the line says the facts do not move.",
    },
  ],
  variants: [
    { name: 'tone="neutral"', when: "The default: no judgement." },
    { name: 'tone="success"', when: "The change is good." },
    {
      name: 'tone="danger"',
      when: "The change is bad, whichever way it moved: more returns.",
    },
    { name: 'tone="attention"', when: "The change is worth a look." },
    { name: 'tone="info"', when: "A plain note." },
  ],
};
