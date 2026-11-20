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
    {
      when: "The foot of a flow that goes on in order, one question at a time: Back, how far through, Next.",
      instead: ["step-foot"],
      source: "docs/components/step-foot.mdx",
    },
    {
      when: "A flow that goes on in order with a quiet bar at its top: Back and Next as ghost arrows either side of the progress.",
      instead: ["step-bar"],
      source: "docs/components/step-bar.mdx",
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
      name: "labelsHidden",
      when: "Many steps in little room: the marks alone, each step's name its tooltip.",
    },
    {
      name: "reached",
      when: "The person may move forward again to any step already reached, not only back.",
    },
    {
      name: "working",
      when: "The current step is under way: its ring gives way to the working light, travelling toward the next step.",
    },
  ],
};
