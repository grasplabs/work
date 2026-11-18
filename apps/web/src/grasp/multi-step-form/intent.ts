// When to use Multi-step form, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A form of fixed height that splits its fields into pages, with Next and Back.",
  useWhen: [
    { when: "A form that must keep one height, whatever its fields need." },
    {
      when: "Blocks of fields that each read well on their own, since any two may land on different pages.",
    },
  ],
  notWhen: [
    {
      when: "A form in named steps, each shown done, current or coming.",
      instead: ["stepper", "form"],
      proposed: true,
    },
    {
      when: "A form with no fixed height, that can grow with its fields.",
      instead: ["form"],
      proposed: true,
    },
    {
      when: "Views of one thing, chosen in any order.",
      instead: ["tabs"],
      source: "docs/patterns/navigation.mdx",
    },
  ],
  variants: [
    {
      name: 'mode="fill"',
      when: "The default: each page packed with as many blocks as fit.",
    },
    {
      name: 'mode="uniform"',
      when: "The same number of blocks on every page.",
    },
  ],
};
