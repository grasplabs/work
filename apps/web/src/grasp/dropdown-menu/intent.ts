// When to use Dropdown menu, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A list of actions on one thing, such as Rename or Move, opened from a button.",
  useWhen: [{ when: "Actions that act on one object, behind a button." }],
  notWhen: [
    { when: "Choosing a value in a form.", instead: ["select"] },
    { when: "A menu with one item.", instead: ["button"] },
    { when: "A task with fields.", instead: ["popover"] },
    { when: "A menu that opens on hover." },
  ],
  variants: [
    {
      name: "danger",
      when: "An item that deletes or cannot be undone, last, after a separator.",
    },
    {
      name: 'align="end"',
      when: "A trigger at the end of a row or a toolbar.",
    },
    {
      name: "chevron",
      when: "A trigger with words, to say a menu opens there.",
    },
  ],
};
