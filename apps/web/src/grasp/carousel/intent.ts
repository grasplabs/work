// When to use Carousel, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A set of slides that people page through with buttons, a swipe or the arrow keys.",
  useWhen: [
    { when: "More slides than fit side by side, each whole on its own." },
  ],
  notWhen: [
    { when: "A few things that fit side by side: show them all." },
    {
      when: "The one thing people must see: put it on the page, not on a later slide.",
    },
    {
      when: "Views of one thing, chosen by name.",
      instead: ["tabs"],
      source: "docs/components/tabs.mdx",
    },
  ],
};
