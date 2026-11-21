// When to use Textarea, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A box for several lines of text that grows taller as you write.",
  useWhen: [{ when: "More than one sentence: Notes, Reason for the change." }],
  notWhen: [
    { when: "One line.", instead: ["input"] },
    {
      when: "A message to an agent in a conversation.",
      instead: ["composer"],
      source: "docs/components/composer.mdx",
    },
  ],
  variants: [
    {
      name: 'submitShortcut="mod+enter"',
      when: "Cmd or Ctrl+Enter sends the form, and the product says so near it.",
    },
    {
      name: "autoResize={false}",
      when: "A fixed height the person can drag taller.",
    },
  ],
};
