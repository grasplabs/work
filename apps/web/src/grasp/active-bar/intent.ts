// When to use Active bar, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A highlight that slides behind the current item in a vertical navigation list.",
  useWhen: [
    { when: "Marking the item you are on in an upright list of navigation." },
  ],
  notWhen: [
    { when: "A row of items: it moves only up and down." },
    { when: "The only sign of the current item: its words change too." },
    {
      when: "A product's whole main navigation, not only its marker.",
      instead: ["sidebar"],
      source: "docs/components/sidebar.mdx",
    },
  ],
};
