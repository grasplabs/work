// When to use Row list, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A list in a card, one line per thing, with actions shown on hover or focus.",
  useWhen: [
    {
      when: "A card's list of things, each one line, with actions that wait for the pointer.",
    },
  ],
  notWhen: [
    {
      when: "More than two actions on a row: put the rest in a menu.",
      instead: ["dropdown-menu"],
    },
    {
      when: "A row that needs a second line.",
      instead: ["item"],
      source: "src/components/row-list/row-list.tsx",
    },
    {
      when: "A list on the page, with its actions always in view.",
      instead: ["item"],
      source: "src/components/row-list/row-list.tsx",
    },
  ],
};
