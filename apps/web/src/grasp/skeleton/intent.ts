// When to use Skeleton, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "Placeholder shapes that stand in for content while it loads, so the page does not jump.",
  useWhen: [
    {
      when: "Content whose shape is known is still loading, so nothing jumps when it arrives.",
    },
  ],
  notWhen: [
    { when: "Something that loads in less than a moment." },
    {
      when: "Neither the length nor the shape of what loads is known.",
      instead: ["spinner"],
      source: "docs/patterns/loading.mdx",
    },
    {
      when: "How far a task has come is known.",
      instead: ["progress"],
      source: "docs/patterns/loading.mdx",
    },
    {
      when: "An agent working, not content loading.",
      instead: ["working-mark"],
      source: "docs/components/working-mark.mdx",
    },
  ],
  variants: [
    { name: 'shape="line"', when: "The default: a line of text." },
    { name: 'shape="block"', when: "An image, a chart or a field." },
    { name: 'shape="circle"', when: "An avatar." },
    {
      name: "pulse={false}",
      when: "A long list, where many breathing at once is noise.",
    },
  ],
};
