// When to use Label, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "The name of a control you can see, tied to it so a press on the name reaches the control.",
  useWhen: [
    {
      when: "A visible name for a control outside a Field: an input, a radio group, a slider.",
      source: "src/components/label/label.tsx",
    },
  ],
  notWhen: [
    {
      when: "A control inside a Field.",
      instead: ["field"],
      source: "src/components/label/label.tsx",
    },
    {
      when: "A row with no room for a visible name: give the control an `aria-label`.",
      source: "docs/patterns/forms.mdx",
    },
  ],
};
