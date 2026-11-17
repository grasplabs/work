// When to use Command, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A search box over a list of actions, where you type to find and run one.",
  useWhen: [
    { when: "A person finds an action by typing and runs it." },
    {
      when: "The list over the page, opened from a button or a shortcut: CommandDialog (once Commandbar).",
      source: "src/components/command/command-dialog.tsx",
    },
  ],
  notWhen: [
    { when: "A command that only goes to another place.", instead: ["link"] },
    {
      when: "Choosing a value in a form.",
      instead: ["combobox", "select"],
      proposed: true,
    },
  ],
  variants: [
    {
      name: "query / onQueryChange / filter={false}",
      when: "Search results the page fetches itself, kept in its order.",
    },
    {
      name: "loading / loadingLabel",
      when: "While the page fetches: the list is busy and says so.",
    },
    {
      name: "actions (on a command) / onRowAction",
      when: "A result has more to do than its one action (copy its link, share it): behind a quiet More, and the right arrow.",
    },
    {
      name: "description and end (on a command)",
      when: "A result needs a second line (where it lives) or something at its end (a count, a face).",
    },
  ],
};
