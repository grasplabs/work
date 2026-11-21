// When to use Kbd, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A key or shortcut to press, shown as it is printed on the keyboard.",
  useWhen: [
    {
      when: "A key or a shortcut to press, in the sentence that says what it does.",
    },
  ],
  notWhen: [
    { when: "A mouse action or a menu path." },
    {
      when: "A list of commands to find and run, each with its shortcut.",
      instead: ["command"],
      source: "docs/components/command.mdx",
    },
  ],
};
