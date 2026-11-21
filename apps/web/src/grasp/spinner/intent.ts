// When to use Spinner, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A small turning icon that shows something is loading or working.",
  useWhen: [
    {
      when: "Something is working and neither its length nor its shape is known.",
      source: "docs/patterns/loading.mdx",
    },
    { when: "Beside words that say what is working: Loading the report." },
  ],
  notWhen: [
    { when: "Something that takes less than a moment." },
    { when: "The shape of the content is known.", instead: ["skeleton"] },
    {
      when: "How far it has come is known.",
      instead: ["progress"],
      source: "docs/patterns/loading.mdx",
    },
    {
      when: "An action on a button: the button says it is working itself.",
      instead: ["button"],
      source: "src/components/spinner/spinner.tsx",
    },
    {
      when: "An agent working, not loading.",
      instead: ["working-mark"],
      source: "docs/components/working-mark.mdx",
    },
  ],
  variants: [
    { name: 'size="sm"', when: "The default: beside small text." },
    { name: 'size="md"', when: "Beside body text." },
    { name: 'size="lg"', when: "Alone in a panel that is still loading." },
  ],
};
