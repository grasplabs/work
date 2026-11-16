// When to use Input group, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A text box with a unit, an icon or a button inside, like a search field.",
  useWhen: [
    { when: "Words that help read the value: a prefix, a unit, a domain." },
    { when: "One button that acts on what the field holds: Copy, Send." },
  ],
  notWhen: [
    { when: "A label or a sentence inside the edge." },
    { when: "More than one button: put the rest beside the field." },
    {
      when: "A field with nothing inside its edge.",
      instead: ["input"],
      source: "docs/components/input.mdx",
    },
  ],
  variants: [
    { name: 'size="md"', when: "The default." },
    { name: 'size="lg"', when: "Where a form has room." },
  ],
};
