// When to use Sheet, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A panel along a side of the window, for details or a task beside the page.",
  useWhen: [
    { when: "Details or a side task that keeps the page in view." },
    { when: "A list of places to go, along the start." },
  ],
  notWhen: [
    { when: "A short yes or no.", instead: ["dialog"] },
    {
      when: "A short task on a phone.",
      instead: ["drawer"],
      source: "docs/components/drawer.mdx",
    },
    {
      when: "A sheet already open: replace its content instead of opening another.",
    },
  ],
  variants: [
    {
      name: 'side="end"',
      when: "The default: details and tasks beside the page.",
    },
    { name: 'side="start"', when: "Places to go." },
    { name: 'size="md"', when: "The default: a form or details." },
    { name: 'size="wide"', when: "A layout of its own." },
  ],
};
