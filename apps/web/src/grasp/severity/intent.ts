// When to use Severity, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: 'A coloured dot that shows how serious something is, such as an error or a warning. Now Badge\'s dot: use Badge with variant="dot".',
  useWhen: [
    {
      when: "How serious something is, such as a captured log: an error, a warning or something only to know.",
      source: "src/components/badge/badge.tsx",
    },
    {
      when: "A page full of them, where the words stay in the text colour and the dot says the level.",
      source: "src/components/badge/badge.tsx",
    },
  ],
  notWhen: [
    {
      when: "How something stands, such as Needs review.",
      instead: ["badge"],
      source: "docs/components/badge.mdx",
    },
    {
      when: "A message the person must read and act on.",
      instead: ["alert"],
      source: "docs/components/toast.mdx",
    },
  ],
  variants: [
    { name: 'level="error"', when: "It stops something." },
    { name: 'level="warning"', when: "It needs a look." },
    { name: 'level="info"', when: "It is only to know." },
  ],
};
