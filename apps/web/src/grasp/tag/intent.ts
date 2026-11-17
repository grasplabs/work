// When to use Tag, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A short label that sorts or names something, in a word or two.",
  useWhen: [
    { when: "A word or two that sorts or names something: Design, Q3 plan." },
    {
      when: "Labels people chose and can take back, each with a remove button.",
    },
  ],
  notWhen: [
    { when: "How something stands.", instead: ["badge"] },
    {
      when: "Something to press or follow: only its remove button acts.",
      instead: ["button", "link"],
    },
    {
      when: "Several values typed into one field.",
      instead: ["tag-input"],
      source: "docs/components/tag-input.mdx",
    },
  ],
  variants: [
    { name: 'variant="soft"', when: "The default: the usual tag." },
    {
      name: 'variant="outline"',
      when: "Quieter, for tags beside chosen ones.",
    },
    { name: 'size="md"', when: "The default: beside body text." },
    { name: 'size="sm"', when: "In a dense row or a table." },
  ],
};
