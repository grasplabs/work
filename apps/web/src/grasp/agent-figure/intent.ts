// When to use AgentFigure, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "An agent's figure: Damsko's Stephen, lit and dithered, in a shape and a palette of its own, posed by the agent's state.",
  useWhen: [
    {
      when: "An agent shown as itself: its card on the Agents page, its own page, the one agent a screen is about.",
    },
    {
      when: "Agents in a list, at 48 or 24 pixels, each still and told apart by its shape and colours.",
    },
  ],
  notWhen: [
    {
      when: "A small tile beside an agent's name in running text.",
      instead: ["agent-mark"],
    },
    { when: "A person or a team.", instead: ["avatar"] },
    {
      when: "Saying that an agent is working right now, in words a person reads.",
      instead: ["working-mark"],
    },
  ],
  variants: [
    {
      name: "decorative",
      when: "The agent's name is written beside it (the default).",
    },
    {
      name: "aria-label",
      when: "It stands alone: it is an image with the agent's name.",
    },
    {
      name: "still",
      when: "Many figures at once: one picture each (the default at xs and sm).",
    },
    {
      name: "follow",
      when: "The one figure a screen is about: its light leans toward the pointer.",
    },
  ],
};
