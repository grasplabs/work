// When to use Artifact viewer, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A viewer for a file an agent or person made, to read, search and comment on.",
  useWhen: [
    {
      when: "A file to read, search and jump through: Markdown, code, text, an image, a PDF, a table or a web page.",
    },
    {
      when: "Comments on a file's words, and an agent's edits to accept or reject.",
    },
  ],
  notWhen: [
    {
      when: "An agent's answer in a conversation.",
      instead: ["markdown", "chat-message"],
      source: "docs/components/markdown.mdx",
    },
    {
      when: "A few lines of code in an answer or a page.",
      instead: ["code-block"],
      source: "docs/components/code-block.mdx",
    },
    {
      when: "What changed between two versions.",
      instead: ["diff"],
      source: "docs/components/diff.mdx",
    },
    {
      when: "Rows to sort, search and choose.",
      instead: ["data-table"],
      source: "docs/components/data-table.mdx",
    },
  ],
  variants: [
    {
      name: "allowScripts",
      when: "A web page whose scripts must run, in the sandbox.",
    },
    { name: "building", when: "An app artifact whose build is not done." },
  ],
};
