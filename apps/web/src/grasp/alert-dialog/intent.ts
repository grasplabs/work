// When to use Alert dialog, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A window that asks one question before a step that cannot be undone.",
  useWhen: [
    {
      when: "A grave loss that cannot be undone, naming the thing and what is lost.",
    },
    {
      when: "A yes to an agent's request that is grave and cannot be undone.",
      source: "docs/patterns/approvals-inbox.mdx",
    },
    {
      when: "The question its delete button asks, when deleting what a form is about is a grave loss.",
      source: "docs/patterns/forms.mdx",
    },
  ],
  notWhen: [
    {
      when: "Something that can be undone: do it at once and offer Undo.",
      instead: ["toast"],
      source: "docs/patterns/confirmations.mdx",
    },
    {
      when: "A small loss that cannot be undone, such as a draft or a member: hold to confirm.",
      instead: ["button"],
      source: "docs/patterns/confirmations.mdx",
    },
    {
      when: "A task with fields to fill, or more than one answer.",
      instead: ["dialog"],
      source: "docs/components/dialog.mdx",
    },
  ],
  variants: [
    { name: 'variant="danger"', when: "On the answer that deletes." },
    {
      name: 'variant="ink"',
      when: "On the answer to a step that is grave but deletes nothing.",
    },
    {
      name: 'variant="quiet"',
      when: "On the safe answer (Keep it): the default.",
    },
  ],
};
