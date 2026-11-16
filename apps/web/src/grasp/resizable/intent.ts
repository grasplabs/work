// When to use Resizable, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A set of panels people resize by dragging the handles between them or with arrow keys.",
  useWhen: [
    { when: "Panels side by side or stacked that people need to resize." },
  ],
  notWhen: [
    { when: "Panels people never need to resize: a fixed layout is simpler." },
    {
      when: "A part that only opens and folds, with no size between.",
      instead: ["collapsible"],
      proposed: true,
      note: "Collapsible fits a part that folds under its trigger, but a side panel that only shows or hides is as close to Sidebar, a Sheet or a collapsible Resizable panel, and nothing written chooses.",
    },
    {
      when: "A line between groups that nobody moves.",
      instead: ["separator"],
      source: "docs/components/separator.mdx",
    },
  ],
  variants: [
    {
      name: 'orientation="horizontal"',
      when: "The default: panels side by side.",
    },
    { name: 'orientation="vertical"', when: "Panels stacked." },
    { name: "grip", when: "A handle people may not find by its line alone." },
    { name: "collapsible", when: "A panel that may fold away." },
  ],
};
