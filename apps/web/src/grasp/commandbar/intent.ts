// When to use Commandbar, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A box over the page where you type to find and run a command. Now Command's CommandDialog: use CommandDialog from command.",
  useWhen: [
    {
      when: "Actions from anywhere on the page, found by typing, behind a button or a shortcut.",
    },
  ],
  notWhen: [
    {
      when: "A list of actions that stays in its place on the page.",
      instead: ["command"],
      source: "docs/components/command.mdx",
    },
    {
      when: "A command that only goes to another place.",
      instead: ["link"],
      source: "docs/components/command.mdx",
    },
    {
      when: "A shortcut the browser already uses.",
      source: "docs/components/command.mdx",
    },
  ],
};
