// When to use Separator, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A thin line that sets apart groups of content on the page.",
  useWhen: [
    {
      when: "Groups of content that belong apart, where space alone does not divide them.",
    },
  ],
  notWhen: [
    { when: "Where space alone already divides." },
    {
      when: "Above a heading that already starts a group, or after another separator.",
    },
    {
      when: "A line people drag to resize what is on each side.",
      instead: ["resizable"],
      source: "docs/components/resizable.mdx",
    },
  ],
  variants: [
    {
      name: 'orientation="horizontal"',
      when: "The default: between groups stacked one above another.",
    },
    { name: 'orientation="vertical"', when: "Between items in a row." },
    {
      name: "decorative",
      when: "The words around it already say the groups are apart, such as or between two ways to sign in.",
    },
  ],
};
