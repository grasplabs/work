// When to use Select, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A field that opens a list below it, so you can choose one value.",
  useWhen: [
    { when: "One value from a list in a form: a role, a time zone." },
    {
      when: "More choices than a radio group shows well, but too few to search.",
      source: "docs/components/radio-group.mdx",
    },
  ],
  notWhen: [
    { when: "An action.", instead: ["dropdown-menu"] },
    {
      when: "A list long enough to search: a dozen or more.",
      instead: ["combobox"],
      source: "docs/components/combobox.mdx",
    },
    {
      when: "Two choices: show both.",
      instead: ["radio-group"],
      source: "docs/components/radio-group.mdx",
    },
  ],
  variants: [
    { name: 'size="sm"', when: "A dense table or a toolbar." },
    { name: 'size="md"', when: "The default." },
    { name: 'size="lg"', when: "The one choice that matters on a phone." },
  ],
};
