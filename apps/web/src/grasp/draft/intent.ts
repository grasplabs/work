// When to use a draft, and when not: its page, its Markdown twin, its registry item and the MCP
// server read this one file (src/intent/README.md). A line with `proposed` is not yet confirmed.
export const intent = {
  what: "Something an agent drafted in its answer, an event or an email, for the person to change and then make real.",
  useWhen: [
    {
      when: "An agent made a thing the person sends or creates: a meeting in the agenda, an email to someone.",
    },
    {
      when: "The person should see and change what will be made before it is made.",
    },
  ],
  notWhen: [
    {
      when: "A spreadsheet or a table of data to save in a sheets service.",
      instead: ["draft-sheet"],
    },
    {
      when: "The agent asks for a yes before it acts, with nothing to change.",
      instead: ["approval-request"],
    },
    {
      when: "The agent needs an answer before it can go on.",
      instead: ["question-tool"],
    },
  ],
  variants: [
    {
      name: "EventDraft",
      when: "A meeting or an event for a calendar.",
      proposed: true,
    },
    {
      name: "EventChangeDraft",
      when: "A change to an event already in a calendar: what changes against what it was.",
      proposed: true,
    },
    {
      name: "EmailDraft",
      when: "An email to one or several people.",
      proposed: true,
    },
    {
      name: "MessageDraft",
      when: "A message to a channel or a person in a chat service.",
      proposed: true,
    },
    {
      name: "ReplyDraft",
      when: "A reply inside an email thread, the message it answers folded under it.",
      proposed: true,
    },
    {
      name: "TaskDraft",
      when: "A to-do or a reminder, for the person or someone else.",
      proposed: true,
    },
  ],
};
