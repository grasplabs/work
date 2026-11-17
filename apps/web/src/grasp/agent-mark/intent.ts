// When to use AgentMark, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "An agent's face: a small dithered tile in the brand's light, drawn from the agent's name.",
  useWhen: [
    {
      when: "An agent, beside its name: in a list, a card, its own page, the answers it gives.",
    },
    {
      when: "An agent being made: its mark comes into being as it is written.",
      source: "handover/agents/DESIGN.md",
    },
  ],
  notWhen: [
    { when: "A person or a team.", instead: ["avatar"] },
    {
      when: "Another company's mark, for an integration or a source.",
      instead: ["brand-icon"],
      source: "docs/components/brand-icons.mdx",
    },
    {
      when: "Saying that an agent is working right now.",
      instead: ["working-mark"],
    },
  ],
  variants: [
    { name: "decorative", when: "The agent's name is written beside it." },
    {
      name: "label",
      when: "It stands alone: it is an image with the agent's name.",
    },
    {
      name: "develop",
      when: "The agent is being made: it comes into being once, as it first shows.",
    },
  ],
};
