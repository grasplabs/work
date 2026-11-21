// When to use Chat start, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "The first screen of a chat, with a question and a box to ask in.",
  useWhen: [
    {
      when: "The screen a chat starts on: the question and the box to ask in.",
    },
  ],
  notWhen: [
    {
      when: "A conversation once it has begun.",
      instead: ["thread", "composer"],
      source: "docs/components/thread.mdx",
    },
    {
      when: "Only what stands behind the page, without the question and the box to ask in.",
      instead: ["backdrop"],
      source: "docs/components/backdrop.mdx",
    },
  ],
  variants: [
    {
      name: 'look={{ backdrop: "none" }}',
      when: "The page's own ground, and the box a plain card.",
    },
  ],
};
