// When to use Toast, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A small message that pops up for a moment to say something happened.",
  useWhen: [
    { when: "A receipt: it says that something happened." },
    {
      when: "Something done that can be brought back, with Undo.",
      source: "docs/patterns/confirmations.mdx",
    },
  ],
  notWhen: [
    {
      when: "Anything a person must read or act on.",
      instead: ["alert", "dialog"],
    },
    { when: "An error that needs fixing before going on." },
    {
      when: "The only sign that something failed.",
      source: "docs/patterns/empty-and-error-states.mdx",
    },
    {
      when: "A message across the whole page or the app that stays until it is dealt with.",
      instead: ["banner"],
      proposed: true,
    },
  ],
  variants: [
    { name: 'align="end"', when: "The default: beside the work." },
    { name: 'align="center"', when: "A message about the whole page." },
  ],
};
