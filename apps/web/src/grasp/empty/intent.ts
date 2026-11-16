// When to use Empty, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "The message a list shows when it has nothing in it, or failed to load.",
  useWhen: [
    { when: "A list with nothing in it yet: say what will appear, and when." },
    { when: "A list whose request failed." },
  ],
  notWhen: [
    {
      when: "A list that is still loading.",
      instead: ["skeleton"],
      source: "docs/patterns/loading.mdx",
    },
    {
      when: "One part of a loaded page failed.",
      instead: ["alert"],
      source: "docs/patterns/empty-and-error-states.mdx",
    },
    {
      when: "An action failed: the control says so itself.",
      instead: ["button"],
      source: "docs/patterns/empty-and-error-states.mdx",
    },
  ],
  variants: [
    {
      name: 'size="page"',
      when: "A whole list or page, standing alone, with a title.",
    },
    {
      name: 'size="section"',
      when: "The default: a card or one tab of a list.",
    },
    { name: 'size="inline"', when: "A small box." },
    { name: 'kind="error"', when: "The request failed." },
  ],
};
