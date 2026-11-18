// When to use Connection row, and when not: its page, its Markdown twin, its registry item and the
// MCP server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "One place an agent can answer (a channel, direct messages) as a settings row: on with a switch, not connected, or broken.",
  useWhen: [
    {
      when: "Choosing where an agent answers: its channels and direct messages, each a switch.",
    },
    {
      when: "A place that is not connected or has lost access: one sentence and the one action that fixes it.",
      source: "handover/agents/DESIGN.md",
    },
  ],
  notWhen: [
    {
      when: "A setting that is not a place to answer.",
      instead: ["setting-row"],
    },
    { when: "A list of connected services to manage.", instead: ["item"] },
  ],
  variants: [
    {
      name: 'status="missing"',
      when: "The place is not connected: a sentence and one action, no switch.",
    },
    {
      name: 'status="broken"',
      when: "It lost access: the switch out of use, a sentence in the attention tone and one action.",
    },
  ],
};
