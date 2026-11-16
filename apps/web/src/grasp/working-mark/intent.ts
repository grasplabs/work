// When to use Working mark, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A small moving mark that shows an agent is working.",
  useWhen: [
    {
      when: "An agent is working, beside words that say what: Searching the web.",
    },
    { when: "Only while the work really runs." },
  ],
  notWhen: [
    { when: "A second working mark in the same view." },
    {
      when: "Loading, not an agent working.",
      instead: ["skeleton", "spinner"],
    },
  ],
  variants: [
    {
      name: "done",
      when: "The work ended: a tick drawn in where it stood. Leave the mark out where the place has a done mark of its own.",
    },
  ],
};
