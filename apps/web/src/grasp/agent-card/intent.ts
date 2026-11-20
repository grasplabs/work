// When to use AgentCard, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "One agent on the Agents page as a portrait card: its name, its job, whom it answers, and its details grown inside the card on hover and focus.",
  useWhen: [
    {
      when: "The Agents page: each agent a card in the grid, the whole card a link to its page or a chat with it.",
    },
  ],
  notWhen: [
    {
      when: "Agents in a list or a picker, at 24 or 48 pixels.",
      instead: ["agent-figure"],
    },
    { when: "An app someone built.", instead: ["app-card"] },
    {
      when: "Facts that need more than three lines, or a control.",
      instead: ["hover-card"],
    },
  ],
  variants: [
    {
      name: "audience",
      when: "Whom it answers, as a pill at rest: Just for me, Everyone, or a team.",
    },
    {
      name: "details",
      when: "Two or three facts worth knowing before opening it, grown inside the card.",
    },
    {
      name: "paused",
      when: "The agent is paused: its figure asleep. Say so with a status badge too.",
    },
  ],
};
