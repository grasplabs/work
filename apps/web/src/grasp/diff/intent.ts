// When to use Diff, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A before-and-after view of changes, marked by line for code and by word for prose.",
  useWhen: [
    { when: "What changed in a file or a document, before and after." },
    { when: "A person answering an agent's edit, change by change." },
  ],
  notWhen: [
    {
      when: "A value that changed: say the old and the new in words.",
      instead: ["text"],
      proposed: true,
    },
    {
      when: "Code to read or copy, with nothing changed.",
      instead: ["code-block"],
      source: "docs/components/code-block.mdx",
    },
  ],
  variants: [
    {
      name: 'mode="unified"',
      when: "The default, and always on a narrow screen.",
    },
    {
      name: 'mode="split"',
      when: "Only where both halves fit, on a wide screen.",
    },
    { name: 'mode="inline"', when: "Prose, so a sentence reads as one." },
    {
      name: "review",
      when: "A person accepts or rejects an agent's edit. Never for a record of the past.",
    },
  ],
};
