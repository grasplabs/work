// When to use DocumentEditor, and when not: its page, its Markdown twin, its registry item and the
// MCP server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "One flowing document written in place, with headings, lists and collapsible sections, kept as Markdown.",
  useWhen: [
    {
      when: "Long structured text a person writes and keeps: an agent's instructions, a playbook, a brief.",
    },
    {
      when: "Text Grasp rewrites for the person, with one undo back to theirs (`rewriting`).",
    },
  ],
  notWhen: [
    { when: "A few plain sentences: a note, a reason.", instead: ["textarea"] },
    { when: "A message to an agent in a conversation.", instead: ["composer"] },
    { when: "Showing Markdown that is not edited.", instead: ["markdown"] },
  ],
  variants: [
    {
      name: "header",
      when: "Actions for the whole document, such as Configure with agent.",
    },
    {
      name: "rewriting",
      when: "Grasp is writing the document: locked, the new text streamed in, one undo back.",
    },
    { name: "readOnly", when: "Shown and selectable, not written in." },
  ],
};
