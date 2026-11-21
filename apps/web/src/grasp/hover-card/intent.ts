// When to use Hover card, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A small card that previews where a link goes, shown when you point at it.",
  useWhen: [
    {
      when: "The name of a person or thing, as a link to a page that holds everything the card shows.",
    },
  ],
  notWhen: [
    { when: "A link in a long list that someone scans quickly." },
    { when: "Anything only the card says." },
    {
      when: "A button, a field or a link people must reach.",
      instead: ["popover"],
      source: "docs/components/tooltip.mdx",
    },
    {
      when: "A short hint for a control.",
      instead: ["tooltip"],
      source: "docs/components/tooltip.mdx",
    },
  ],
  variants: [{ name: 'align="start"', when: "A card that opens from a list." }],
};
