// When to use Icon tile, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A small square with an object's icon, shown at the top of its details panel.",
  useWhen: [
    {
      when: "The head of an inspector: one tile per view, for the object the view is about.",
    },
  ],
  notWhen: [
    {
      when: "Something people press: it is a mark, not a control.",
      instead: ["button"],
      proposed: true,
    },
    {
      when: "A person or a team as a picture, or their initials.",
      instead: ["avatar"],
      source: "docs/components/avatar.mdx",
    },
  ],
  variants: [
    { name: 'look="raised"', when: "The default: a quiet head." },
    { name: 'look="tint"', when: "A wash of mint." },
    {
      name: 'look="gradient"',
      when: "The one object a view is about. Never two in a view.",
    },
    {
      name: "running",
      when: "The object is working now. Say it in words too.",
    },
  ],
};
