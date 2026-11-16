// When to use Key and value rows, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A list of facts about one thing, each a short name with its value.",
  useWhen: [
    {
      when: "Facts about one thing, each named in a few words with its value.",
    },
    { when: "An id someone may need to copy." },
  ],
  notWhen: [
    {
      when: "The same facts for many things, compared row by row.",
      instead: ["table"],
      source: "docs/patterns/tables.mdx",
    },
    {
      when: "Values someone fills in or changes.",
      instead: ["field", "input"],
      source: "docs/patterns/forms.mdx",
    },
    {
      when: "What a thing is and what it is made of, in a panel beside its page.",
      instead: ["inspector-panel"],
      proposed: true,
      note: "Inspector panel draws a thing's parts as rows from data, yet a thing's plain facts in a panel section, such as its owner, its date or its id, are still key and value rows.",
    },
  ],
  variants: [
    {
      name: 'layout="stacked"',
      when: "The default: each name above its value.",
    },
    { name: 'layout="inline"', when: "A short list in a small space." },
  ],
};
