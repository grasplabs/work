// When to use Backdrop, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A background drawn behind the page where a chat starts, as a scene, dither or sand.",
  useWhen: [
    { when: "Behind a page where a chat starts: a scene, a dither or sand." },
  ],
  notWhen: [
    {
      when: "The whole screen a chat starts on, with its question and the box to ask in.",
      instead: ["chat-start"],
      source: "docs/components/chat-start.mdx",
    },
    {
      when: "A surface for one thing inside a page.",
      instead: ["card"],
      source: "docs/components/card.mdx",
    },
  ],
};
