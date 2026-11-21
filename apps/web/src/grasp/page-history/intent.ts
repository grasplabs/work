// When to use Page history, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A page's saved versions in a sheet: who changed it and when, what changed since, and Restore.",
  useWhen: [
    {
      when: "A page several people edit, kept as Markdown, whose earlier versions someone may want to see or bring back.",
    },
  ],
  notWhen: [
    {
      when: "Two texts side by side, with nothing to restore.",
      instead: ["diff"],
    },
    { when: "Changes across several files.", instead: ["diff-files"] },
  ],
};
