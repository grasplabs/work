// When to use Composer, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "The box where a person writes to an assistant and sees when it is working.",
  useWhen: [
    {
      when: "A conversation with an assistant: one composer, at the foot of it.",
    },
  ],
  notWhen: [
    { when: "A second composer in the same conversation." },
    {
      when: "Several lines of text in a form, sent with the form.",
      instead: ["textarea"],
      source: "docs/components/textarea.mdx",
    },
    {
      when: "The whole first screen of a chat on a backdrop: Chat start holds the Composer.",
      instead: ["chat-start"],
      source: "docs/components/chat-start.mdx",
    },
  ],
  variants: [
    {
      name: "showWorking",
      when: "Say under the card what the agent is doing now, while it works.",
    },
    {
      name: 'surface="glass"',
      when: "It stands on a backdrop, which shows through.",
    },
    { name: "accent", when: "The light in an agent's own colour." },
  ],
};
