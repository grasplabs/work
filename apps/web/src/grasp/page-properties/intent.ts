// When to use Page properties, and when not: its page, its Markdown twin, its registry item and the
// MCP server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A page's facts and open questions, one quiet press away under its title.",
  useWhen: [
    {
      when: "A page people read and edit, whose facts (kind, source, team, updated) matter only now and then.",
    },
    {
      when: "Questions the page cannot answer yet, each waiting for the person who can.",
    },
  ],
  notWhen: [
    {
      when: "Facts that must always show, as an agent's brief does.",
      instead: ["key-value"],
    },
    {
      when: "What a thing is made of, beside its page.",
      instead: ["inspector-panel"],
    },
  ],
  variants: [
    {
      name: "defaultOpen",
      when: "A page opened to check its facts: they show at first.",
    },
    {
      name: "open",
      when: "The host keeps it open or closed, as with a shortcut.",
    },
  ],
};
