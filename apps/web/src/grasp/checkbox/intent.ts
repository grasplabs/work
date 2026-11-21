// When to use Checkbox, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A box you tick to turn a choice on or off, alone or in a group.",
  useWhen: [
    { when: "One choice on or off, or several that make one answer." },
    {
      when: "A choice in a form that waits for a Save button.",
      source: "docs/components/switch.mdx",
    },
    {
      when: "A choice someone must accept, like terms.",
      source: "docs/components/switch.mdx",
    },
  ],
  notWhen: [
    {
      when: "A choice that does something at once.",
      instead: ["switch", "button"],
    },
    {
      when: "One answer from a few choices.",
      instead: ["radio-group"],
      source: "docs/components/radio-group.mdx",
    },
  ],
};
