// When to use Approval request, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `source` comes from that file, a
// line with `proposed` is not yet confirmed, and any other restates the component's own page.
export const intent = {
  what: "A card where an agent asks a person to approve an action before it goes ahead.",
  useWhen: [
    { when: "An agent needs a person's yes before it acts." },
    {
      when: "A change the agent wants, waiting in the thread until someone answers.",
      source: "docs/patterns/agent-workspace.mdx",
    },
  ],
  notWhen: [
    {
      when: "Approving from a table row: a yes is given with the request read.",
      source: "docs/patterns/approvals-inbox.mdx",
    },
    {
      when: "A question the agent asks, answered with a choice or a few words.",
      instead: ["question-tool"],
      source: "docs/components/question-tool.mdx",
    },
    {
      when: "A person's own grave step, not an agent's ask.",
      instead: ["alert-dialog"],
      source: "docs/components/alert-dialog.mdx",
    },
  ],
  variants: [
    {
      name: "grave",
      when: "Money, deletion and anything sent outside the workspace: it asks twice.",
    },
  ],
};
