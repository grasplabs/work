// When to use DiffFiles, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "What changes across several files, one diff per file under a head with its path, its kind of change and its counts.",
  useWhen: [
    {
      when: "A change that spans files: what a publish or an agent's edit will add, change and delete.",
    },
  ],
  notWhen: [
    {
      when: "One file or one document.",
      instead: ["diff"],
      source: "docs/components/diff.mdx",
    },
    {
      when: "A person answering an agent's edit, change by change.",
      instead: ["diff"],
      proposed: true,
    },
  ],
  variants: [
    {
      name: "total",
      when: "The line on top with the files changed and their counts. Leave it on unless the page says them.",
    },
    {
      name: "foldFrom",
      when: "A file with more changed lines than this opens folded, so a big file does not bury the rest.",
    },
  ],
};
