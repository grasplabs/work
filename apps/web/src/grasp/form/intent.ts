// When to use Form, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A layout that stacks a form's fields in one column, with its buttons at the end.",
  useWhen: [
    {
      when: "Fields down one column, two in a row where they belong together, the buttons at the end.",
    },
    { when: "Fields in groups, each under a title and a sentence." },
  ],
  notWhen: [
    {
      when: "A form in a fixed height that must be split into pages.",
      instead: ["multi-step-form"],
      source: "docs/components/multi-step-form.mdx",
    },
    {
      when: "One control with its label and its error.",
      instead: ["field"],
      source: "src/components/field/field.tsx",
    },
  ],
};
