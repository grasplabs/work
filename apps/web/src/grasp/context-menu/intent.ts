// When to use Context menu, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A menu of actions for a thing, opened by right-clicking or long-pressing it.",
  useWhen: [
    {
      when: "A quicker way to the actions a button or a row's own menu already offers.",
    },
  ],
  notWhen: [
    {
      when: "The only way to reach the actions.",
      instead: ["dropdown-menu", "button"],
    },
    { when: "On the page itself, or on text people select." },
    {
      when: "More than about ten items: group them, or move the rest to a page.",
    },
    {
      when: "The menus of a tool people work in for a long time.",
      instead: ["menubar"],
      source: "docs/components/menubar.mdx",
    },
  ],
  variants: [
    {
      name: "danger",
      when: "An action that destroys or removes. Never on any other.",
    },
  ],
};
