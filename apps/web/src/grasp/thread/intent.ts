// When to use Thread, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "The scrolling list of a chat's messages, which follows the newest and keeps your place.",
  useWhen: [
    { when: "A conversation's messages, the newest at the bottom." },
    {
      when: "An agent writes while the person reads: it follows the latest and keeps their place when they scroll up.",
    },
  ],
  notWhen: [
    {
      when: "One message on its own.",
      instead: ["chat-message"],
      source: "docs/components/chat-message.mdx",
    },
    {
      when: "A list of things that is not a conversation.",
      instead: ["row-list", "data-table"],
      proposed: true,
    },
  ],
  variants: [
    {
      name: 'startAt="unread"',
      when: "Open at the Unread line, so the person reads on from where they left.",
    },
    {
      name: "answerTo",
      when: "A message just sent: it goes to the top, and the answer grows into the room under it.",
    },
  ],
};
