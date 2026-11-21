// When to use Inspector panel, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A panel beside a page, built from data, that shows a thing and its parts.",
  useWhen: [
    {
      when: "What a thing is and what it is made of, beside its page, from data.",
    },
  ],
  notWhen: [
    {
      when: "A layout the panel cannot say.",
      instead: ["panel", "panel-section"],
      source: "src/components/inspector-panel/inspector-panel.tsx",
    },
    {
      when: "On a phone.",
      instead: ["sheet"],
      source: "docs/patterns/inspector.mdx",
    },
  ],
};
