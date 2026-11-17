// When to use Combobox, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A field you type into to find one value in a long list, then choose it.",
  useWhen: [
    { when: "The list is long enough to search: a dozen choices or more." },
  ],
  notWhen: [
    { when: "A handful of choices.", instead: ["select"] },
    { when: "Free text as the value.", instead: ["input"] },
    {
      when: "Several values in one field, each a tag.",
      instead: ["tag-input"],
      source: "docs/components/tag-input.mdx",
    },
  ],
  variants: [
    { name: 'size="md"', when: "The default." },
    { name: 'size="sm"', when: "In a dense table." },
    { name: 'size="lg"', when: "The one choice that matters on a phone." },
  ],
};
