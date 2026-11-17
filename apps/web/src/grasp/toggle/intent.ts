// When to use Toggle, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A button that stays pressed to keep a choice on, like a view or text style.",
  useWhen: [
    { when: "A choice that stays on, such as a view or a text style." },
  ],
  notWhen: [
    { when: "An action that happens once.", instead: ["button"] },
    { when: "In a form: it sends nothing.", instead: ["checkbox"] },
    { when: "A setting named by a label beside it.", instead: ["switch"] },
  ],
  variants: [
    { name: 'size="md"', when: "The default: beside other controls." },
    { name: 'size="sm"', when: "In a dense toolbar." },
    {
      name: "multiple",
      when: "Each toggle in the group can be pressed on its own.",
    },
  ],
};
