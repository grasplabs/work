// When to use Identity card, and when not: its page, its Markdown twin, its registry item and the
// MCP server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "Who something is, on a card: its mark, its name, a few facts and one action.",
  useWhen: [
    {
      when: "The head of a settings page about one organisation, company or person: Workspace, Billing details.",
    },
    {
      when: "A name with a few short facts beside it, changed through one action.",
    },
  ],
  notWhen: [
    { when: "Settings that change one by one.", instead: ["setting-row"] },
    {
      when: "An app or an agent to open.",
      instead: ["app-card", "agent-card"],
    },
    {
      when: "A part of a page with a title and rows.",
      instead: ["section-card"],
    },
  ],
  variants: [
    {
      name: "title",
      when: "In a settings column: the title stands over the card, as a grouped Section card's.",
    },
    {
      name: "cover",
      when: "The page is about this one: a faint dither across the top, the mark over its edge.",
    },
    {
      name: "empty",
      when: "Nothing on file yet: a quiet line in the name's place.",
    },
    {
      name: "loading",
      when: "Before it arrives: the name and each fact wait as their own frames.",
    },
  ],
};
