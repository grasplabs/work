// When to use Stepper, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A list of named steps that shows which are done, current, still to come or failed.",
  useWhen: [
    {
      when: "Steps in order, each named, showing which are done, current, coming or failed.",
    },
  ],
  notWhen: [
    {
      when: "A way to move between the steps: it only shows progress.",
      instead: ["multi-step-form"],
      proposed: true,
    },
    {
      when: "Views of one thing, not steps in order.",
      instead: ["tabs"],
      source: "docs/patterns/navigation.mdx",
    },
    {
      when: "How far one task has come, with no named steps.",
      instead: ["progress"],
      source: "docs/components/progress.mdx",
    },
  ],
  variants: [
    {
      name: 'orientation="horizontal"',
      when: "The default: across, the names beside their marks.",
    },
    {
      name: 'orientation="vertical"',
      when: "Down, with room for each step's description.",
    },
    {
      name: "working",
      when: "The current step is under way: its ring gives way to the working light, travelling toward the next step.",
    },
  ],
};
