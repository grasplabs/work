// When to use Switch, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A control you press to turn a setting on or off, taking effect at once.",
  useWhen: [
    { when: "A setting, named by its label, that takes effect at once." },
    {
      when: "The change is saved to a server: with `onSave` it says how it went.",
    },
  ],
  notWhen: [
    { when: "A form that waits for a Save button.", instead: ["checkbox"] },
    {
      when: "A choice someone must accept, like terms.",
      instead: ["checkbox"],
    },
    {
      when: "A button that stays pressed in a toolbar, with no label beside it.",
      instead: ["toggle"],
      source: "docs/components/toggle.mdx",
    },
  ],
};
