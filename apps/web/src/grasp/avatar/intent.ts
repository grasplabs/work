// When to use Avatar, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A small round picture of a person or team, showing initials when there is none.",
  useWhen: [
    { when: "A person or a team, as their picture or their initials." },
  ],
  notWhen: [
    {
      when: "Another company's mark, for an integration, a source or a way to sign in.",
      instead: ["brand-icon"],
      source: "docs/components/brand-icons.mdx",
    },
    { when: "A picture that is not of the person or team." },
    { when: "The only way to tell people apart: their names say it." },
    {
      when: "The kind of object a view is about, at the head of its inspector.",
      instead: ["icon-tile"],
      source: "docs/components/icon-tile.mdx",
    },
  ],
  variants: [{ name: "decorative", when: "The name is written beside it." }],
};
