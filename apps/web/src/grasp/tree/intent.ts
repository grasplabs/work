// When to use Tree, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A list of nested items, like folders and files, that open and close.",
  useWhen: [
    {
      when: "Nested items that open and close: folders and files, or the pages of a section.",
    },
    { when: "A large tree, where only what is opened is fetched." },
  ],
  notWhen: [
    { when: "A flat list.", instead: ["item", "select"] },
    {
      when: "More than a few levels: show the path instead.",
      instead: ["breadcrumb"],
      proposed: true,
    },
  ],
  variants: [
    { name: 'mode="single"', when: "The default: one item chosen." },
    { name: 'mode="multiple"', when: "Several items chosen at once." },
    { name: 'mode="none"', when: "A tree that only opens and runs." },
  ],
};
