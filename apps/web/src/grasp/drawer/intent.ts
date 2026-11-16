// When to use Drawer, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A panel that slides up from the bottom for a short task on a phone.",
  useWhen: [{ when: "A short task on a phone." }],
  notWhen: [
    { when: "A task on a wide screen.", instead: ["dialog", "sheet"] },
    { when: "A second task over an open drawer: finish one first." },
  ],
  variants: [
    {
      name: "snapPoints",
      when: "The lower height is useful on its own, as a list of results.",
    },
    {
      name: "dismissible={false}",
      when: "Unsaved work a drag would lose: ask in `onDismissAttempt`.",
    },
  ],
};
