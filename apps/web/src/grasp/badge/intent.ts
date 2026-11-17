// When to use Badge, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A small label of a word or two that shows the status of something.",
  useWhen: [
    {
      when: "How something stands, in a word or two, beside what it describes.",
    },
    { when: "A row's status, at the end of the row." },
    {
      when: 'How serious something is, such as a captured log, on a page full of them: `variant="dot"`, a dot beside words in the text colour.',
      source: "src/components/badge/badge.tsx",
    },
  ],
  notWhen: [
    { when: "Something to press or follow.", instead: ["button", "link"] },
    {
      when: "A label that sorts or names something.",
      instead: ["tag"],
      source: "docs/components/tag.mdx",
    },
  ],
  variants: [
    { name: 'tone="neutral"', when: "A plain fact: the default." },
    { name: 'tone="success"', when: "It is done or fine." },
    { name: 'tone="attention"', when: "Someone should look." },
    { name: 'tone="danger"', when: "It failed or is blocked." },
    { name: 'tone="info"', when: "A note." },
    { name: 'size="sm"', when: "A dense table." },
    {
      name: 'variant="dot"',
      when: "How serious: a dot in the tone's colour beside neutral words (once Severity).",
    },
    {
      name: "pending",
      when: "Something is happening to it now: an invitation sending, a member being removed.",
    },
  ],
};
