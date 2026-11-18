// When to use Button group, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A row of buttons for actions on the same thing, like Archive and Delete.",
  useWhen: [
    { when: "Buttons that act on the same thing." },
    {
      when: "A split button: the usual action, and a button for its other ways.",
    },
  ],
  notWhen: [
    { when: "A choice that stays on.", instead: ["toggle"] },
    {
      when: "The view's main action: it has its own ink button.",
      instead: ["button"],
    },
    {
      when: "Many actions for one thing, most of them rarely used.",
      instead: ["dropdown-menu"],
      proposed: true,
    },
  ],
  variants: [
    {
      name: 'orientation="vertical"',
      when: "Buttons stacked, each as wide as the widest.",
    },
  ],
};
