// When to use Interview, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "An interview's transcript, quotes and themes, each tied to its moment.",
  useWhen: [
    {
      when: "An interview read as a transcript, with quotes, themes and moments that cite where they came from.",
    },
    { when: "An answer that cites a moment of an interview." },
  ],
  notWhen: [
    {
      when: "A sound with no transcript.",
      instead: ["audio-player"],
      source: "docs/components/audio-player.mdx",
    },
    {
      when: "A conversation with an assistant.",
      instead: ["thread", "chat-message", "composer"],
      source: "docs/components/chat-message.mdx",
    },
  ],
  variants: [
    {
      name: "search",
      when: "A long transcript: find in page cannot reach the turns that are not drawn.",
    },
    { name: 'size="sm"', when: "A quote in a list." },
    { name: 'size="md"', when: "The default: a quote on its own." },
    { name: 'size="lg"', when: "A page's one quote." },
  ],
};
