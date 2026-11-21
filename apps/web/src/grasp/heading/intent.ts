// When to use Heading, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A title for a page, section or card, with its outline level and size set separately.",
  useWhen: [
    {
      when: "A title in the page's outline, its level kept whole and its look chosen by `size`.",
    },
  ],
  notWhen: [
    { when: "A smaller title by skipping a level: change `size` instead." },
    {
      when: "A page's title row, with its line, actions and tabs.",
      instead: ["page-header"],
      source: "docs/components/page-header.mdx",
    },
    {
      when: "A section's title, with a sentence and its actions.",
      instead: ["section-header"],
      source: "docs/components/section-header.mdx",
    },
    {
      when: "Running words.",
      instead: ["text"],
      source: "docs/components/text.mdx",
    },
  ],
  variants: [
    { name: 'size="xl"', when: "An opening title." },
    { name: 'size="lg"', when: "A page title: the default for level 1." },
    { name: 'size="md"', when: "A section: the default for level 2." },
    { name: 'size="sm"', when: "A card or a panel: the default for level 3." },
    {
      name: 'size="ui"',
      when: "A component's own title, in the sans: the default for level 4.",
    },
    {
      name: 'size="ui-sm"',
      when: "A section's title inside a page or panel, as small as its words: a group of settings.",
    },
  ],
};
