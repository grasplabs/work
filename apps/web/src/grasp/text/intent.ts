// When to use Text, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "Body text for paragraphs and labels, in one of four sizes and four shades.",
  useWhen: [
    {
      when: "Running words, so a product never sets a font size, a line height or a grey by hand.",
      source: "src/components/text/text.tsx",
    },
  ],
  notWhen: [
    {
      when: "A title in the page's outline.",
      instead: ["heading"],
      source: "docs/components/heading.mdx",
    },
    {
      when: "Code of more than a word or two.",
      instead: ["code-block"],
      source: "docs/components/code-block.mdx",
    },
    {
      when: "Words that take you somewhere.",
      instead: ["link"],
      source: "docs/components/link.mdx",
    },
  ],
  variants: [
    {
      name: 'wrap="truncate"',
      when: "One line in a dense row (an email, a path): cut with an ellipsis, the whole in its tooltip.",
    },
    {
      name: 'wrap="anywhere"',
      when: "An email or an id in a box that sizes to what it holds.",
    },
    { name: 'size="xs"', when: "Notes, tags and labels." },
    { name: 'size="sm"', when: "Controls, menus and dense lists." },
    { name: 'size="md"', when: "The default: body text." },
    { name: 'size="lg"', when: "A lead under a page title." },
    { name: 'tone="ink"', when: "Words that must be read first." },
    { name: 'tone="text"', when: "The default: body text." },
    { name: 'tone="muted"', when: "What supports the body text." },
    { name: 'tone="quiet"', when: "The least: a timestamp, a count." },
    { name: 'weight="medium"', when: "A label or a name." },
  ],
};
