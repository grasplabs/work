// When to use Item, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A list row that names a thing and links to it or acts on it.",
  useWhen: [
    {
      when: "A row that names a thing and says where it stands: a date, a state, a count.",
    },
    {
      when: "The whole row goes somewhere: give it `href`, and no buttons inside.",
    },
  ],
  notWhen: [
    { when: "A choice in a menu.", instead: ["dropdown-menu"] },
    {
      when: "More than two actions on a row: put the rest in a menu.",
      instead: ["dropdown-menu"],
    },
    {
      when: "A list inside a card, one 44px line each, with actions that wait for the pointer.",
      instead: ["row-list"],
      source: "docs/components/row-list.mdx",
    },
    {
      when: "Rows of like things compared column by column.",
      instead: ["table", "data-table"],
      source: "docs/patterns/tables.mdx",
    },
  ],
  variants: [
    {
      name: 'variant="plain"',
      when: "The default: rows in a list on the page, with hairlines between them in a long one.",
    },
    { name: 'variant="outline"', when: "A few rows that stand alone." },
    { name: 'variant="soft"', when: "A row on a quieter fill." },
    { name: 'size="sm"', when: "A dense list." },
    {
      name: "detail",
      when: 'A quieter word on the name\'s line: a role, "You", a count.',
    },
    {
      name: 'size="xs"',
      when: "A list among setting rows (members, providers): the setting rows' height and inset.",
    },
    {
      name: "separated",
      when: "A hairline between plain rows in a long list.",
    },
    {
      name: "media",
      when: "A person (an Avatar) or a provider (a Brand icon) by the row's name.",
    },
    {
      name: 'iconLook="inline"',
      when: "A dense row whose icon needs no square.",
    },
  ],
};
