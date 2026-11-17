// When to use Dialog, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A window over the page for one short task, closed by its own buttons.",
  useWhen: [
    {
      when: "A task that needs the page out of the way, finished by its actions.",
    },
    { when: "A short yes or no.", source: "docs/components/sheet.mdx" },
  ],
  notWhen: [
    {
      when: "A small task beside the control that opened it, with the page in reach.",
      instead: ["popover"],
    },
    {
      when: "A menu or a hint.",
      instead: ["dropdown-menu", "tooltip"],
      proposed: true,
    },
    {
      when: "Details or a side task that keeps the page in view.",
      instead: ["sheet"],
      source: "docs/components/sheet.mdx",
    },
    {
      when: "One question before a grave step that cannot be undone.",
      instead: ["alert-dialog"],
      source: "docs/components/alert-dialog.mdx",
    },
  ],
  variants: [
    { name: 'size="md"', when: "The default: a form or a short task." },
    {
      name: 'size="full"',
      when: "A chart or a table opened in full, the page out of the way.",
    },
  ],
};
