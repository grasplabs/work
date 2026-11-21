// When to use Code block, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A box of highlighted code, with its language named, line numbers and a copy button.",
  useWhen: [
    { when: "Code in an answer or a page, for people to read and copy." },
    {
      when: "Code of more than a word or two, which a paragraph should not hold.",
    },
  ],
  notWhen: [
    { when: "A screenshot of code: people need to copy it." },
    {
      when: "A key to press.",
      instead: ["kbd"],
      source: "docs/components/kbd.mdx",
    },
    {
      when: "A whole file to read, search and comment on.",
      instead: ["artifact-viewer"],
      source: "docs/components/artifact-viewer.mdx",
    },
    {
      when: "What changed, before and after.",
      instead: ["diff"],
      source: "docs/components/diff.mdx",
    },
  ],
  variants: [
    { name: "lineNumbers={false}", when: "A command to copy and run." },
    { name: "marked", when: "The lines an answer is about." },
    { name: "streaming", when: "An agent is still writing it." },
  ],
};
