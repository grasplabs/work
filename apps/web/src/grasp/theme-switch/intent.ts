// When to use Theme switch, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A control for choosing light, dark or the system's theme, or one of Grasp's themes.",
  useWhen: [
    {
      when: "A person chooses light, dark or the system's theme, kept with the product's settings.",
    },
  ],
  notWhen: [
    {
      when: "A theme for only the part it sits in, unless that part is meant to stand apart.",
    },
    {
      when: "Any other setting that turns on or off.",
      instead: ["switch"],
      source: "docs/components/switch.mdx",
    },
    {
      when: "The language the product speaks.",
      instead: ["language-switch"],
      source: "docs/components/language-switch.mdx",
    },
  ],
  variants: [
    { name: 'form="segmented"', when: "The default: in a header or a menu." },
    { name: 'form="icon"', when: "Where space is short." },
    { name: 'form="picker"', when: "On a settings page." },
  ],
};
